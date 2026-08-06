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
      '.p86mk-done.gap{color:#f4cf94;}',
      // add / deactivate
      '.p86mk-bar{display:flex;align-items:center;gap:10px;margin-bottom:10px;}',
      '.p86mk-add{background:var(--surface2,#151d2c);border:1px solid var(--border,#2a2f3e);color:var(--text,#e9ecf5);',
      'border-radius:7px;padding:6px 11px;font-size:12px;font-weight:600;cursor:pointer;}',
      '.p86mk-add:hover{border-color:#3f6bb8;}',
      '.p86mk-count{font-size:11px;color:var(--text-dim,#7f8699);}',
      '.p86mk-new{border:1px solid #3f6bb8;border-radius:9px;padding:12px;margin-bottom:12px;',
      'background:var(--surface2,#151d2c);}',
      '.p86mk-newbtns{display:flex;align-items:center;gap:10px;margin-top:10px;}',
      '.p86mk-cancel{background:none;border:1px solid var(--border,#2a2f3e);color:var(--text-dim,#7f8699);',
      'border-radius:6px;padding:5px 10px;font-size:11.5px;cursor:pointer;}',
      '.p86mk-err{font-size:11.5px;color:var(--red,#f87171);}',
      // The row action is quiet until hover so the list still reads as a list.
      '.p86mk-act{opacity:0;background:none;border:1px solid var(--border,#2a2f3e);border-radius:6px;',
      'color:var(--text-dim,#7f8699);font-size:10.5px;padding:3px 8px;cursor:pointer;flex:0 0 auto;',
      'transition:opacity .12s;}',
      '.p86mk-row:hover .p86mk-act,.p86mk-row.off .p86mk-act{opacity:1;}',
      '.p86mk-act:hover{color:var(--red,#f87171);border-color:var(--red,#f87171);}',
      '.p86mk-row.off .p86mk-act:hover{color:var(--green,#34d399);border-color:var(--green,#34d399);}',
      '.p86mk-row.off{opacity:.55;}',
      '.p86mk-inact{font-size:10px;text-transform:uppercase;letter-spacing:.4px;color:#f4cf94;',
      'border:1px solid #f4cf9455;border-radius:4px;padding:1px 5px;}',
      '.p86mk-del:hover{color:var(--red,#f87171);border-color:var(--red,#f87171);}',
      '.p86mk-delhead{font-size:13px;font-weight:700;color:var(--red,#f87171);margin-bottom:2px;}',
      '.p86mk-delsub{font-size:11.5px;color:var(--text-dim,#7f8699);margin-bottom:10px;}'
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
  var _spec = null, _markets = [], _openId = null, _adding = false;

  function completeness(m) {
    if (!_spec) return null;
    var optional = _spec.settings.filter(function (s) { return !s.required; });
    var set = optional.filter(function (s) {
      var v = m[s.key];
      return v !== null && v !== undefined && v !== '';
    }).length;
    return { set: set, total: optional.length };
  }

  // The create row is built from the registry's own required fields, so a
  // new required column becomes a create input automatically rather than
  // being a fourth place to remember.
  function requiredFields() {
    return _spec ? _spec.settings.filter(function (s) { return s.required; }) : [];
  }

  function createFormHTML() {
    return '<div class="p86mk-new">' +
      '<div class="p86set-grid">' + requiredFields().map(function (s) { return field(s, ''); }).join('') + '</div>' +
      '<div class="p86mk-newbtns">' +
        '<button type="button" class="p86set-save" data-mk-create>Create market</button>' +
        '<button type="button" class="p86mk-cancel" data-mk-cancel>Cancel</button>' +
        '<span class="p86mk-err" data-mk-err></span>' +
      '</div></div>';
  }

  function paint() {
    var host = document.getElementById('admin-markets-host');
    if (!host) return;
    injectStyle();
    var rows = _markets.map(function (m) {
      var c = completeness(m);
      var gap = c && c.set === 0;
      var off = m.active === false;
      return '<div class="p86mk-row' + (String(_openId) === String(m.id) ? ' on' : '') + (off ? ' off' : '') +
               '" data-id="' + esc(m.id) + '">' +
        '<span class="p86mk-sw" style="background:' + esc(m.color || '#4f8cff') + '"></span>' +
        '<span class="p86mk-nm">' + esc(m.name) + '</span>' +
        '<span class="p86mk-cd">' + esc(m.code || '') + (m.state ? ' · ' + esc(m.state) : '') + '</span>' +
        (off ? '<span class="p86mk-inact">inactive</span>' : '') +
        '<span class="p86mk-sp"></span>' +
        (c ? '<span class="p86mk-done' + (gap ? ' gap' : '') + '">' + c.set + ' / ' + c.total + ' set</span>' : '') +
        // Deactivate, not delete — the server soft-deletes (active=FALSE) so
        // jobs and leads already pointing at this market keep resolving. Say
        // what it actually does rather than promising a delete it won't do.
        '<button type="button" class="p86mk-act" data-act="' + (off ? 'on' : 'off') + '" ' +
                'data-mk-id="' + esc(m.id) + '" title="' +
                (off ? 'Reactivate this market' : 'Deactivate — hides it from pickers, keeps existing records intact') + '">' +
          (off ? 'Reactivate' : 'Deactivate') + '</button>' +
        // Deactivate hides a market you still operate; delete is for one that
        // shouldn't exist at all. Separate actions because they are separate
        // intents and only one of them is reversible.
        '<button type="button" class="p86mk-act p86mk-del" data-act="del" ' +
                'data-mk-id="' + esc(m.id) + '" title="Delete this market permanently">Delete</button>' +
        '</div>';
    }).join('');
    host.innerHTML =
      '<div class="p86mk-bar">' +
        '<button type="button" class="p86mk-add" data-mk-add>+ New market</button>' +
        '<span class="p86mk-count">' + _markets.length + ' market' + (_markets.length === 1 ? '' : 's') + '</span>' +
      '</div>' +
      (_adding ? createFormHTML() : '') +
      '<div class="p86mk-list">' + rows + '</div><div id="admin-market-form"></div>';

    host.querySelector('.p86mk-list').addEventListener('click', function (e) {
      // Row actions must not also open/close the row underneath them.
      var act = e.target.closest('.p86mk-act');
      if (act) {
        e.stopPropagation();
        var a = act.getAttribute('data-act');
        if (a === 'del') deleteMarket(act.getAttribute('data-mk-id'));
        else toggleActive(act.getAttribute('data-mk-id'), a);
        return;
      }
      var r = e.target.closest('.p86mk-row'); if (!r) return;
      var id = r.getAttribute('data-id');
      _openId = (String(_openId) === String(id)) ? null : id;
      paint();
    });

    var addBtn = host.querySelector('[data-mk-add]');
    if (addBtn) addBtn.addEventListener('click', function () { _adding = !_adding; paint(); });
    var cancelBtn = host.querySelector('[data-mk-cancel]');
    if (cancelBtn) cancelBtn.addEventListener('click', function () { _adding = false; paint(); });
    var createBtn = host.querySelector('[data-mk-create]');
    if (createBtn) createBtn.addEventListener('click', function () { createMarket(host, createBtn); });

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

  function createMarket(host, btn) {
    var errEl = host.querySelector('[data-mk-err]');
    var body = {};
    requiredFields().forEach(function (s) {
      var el = host.querySelector('#set_' + s.key);
      if (el) body[s.key] = el.value;
    });
    // Mirror the server's own required checks so the common mistakes get a
    // useful message here instead of a bare 400.
    var missing = requiredFields().filter(function (s) { return !String(body[s.key] || '').trim(); });
    if (missing.length) {
      if (errEl) errEl.textContent = 'Required: ' + missing.map(function (s) { return s.label; }).join(', ');
      return;
    }
    if (errEl) errEl.textContent = '';
    btn.disabled = true;
    window.p86Api.post('/api/markets', body)
      .then(function (res) {
        var m = (res && res.market) || null;
        if (m) _markets = _markets.concat([m]);
        _adding = false;
        _openId = m ? m.id : null;   // drop straight into the new market's settings
        paint();
        // The switcher and every market chip read a cached list — without
        // this the new market exists but is invisible until a reload.
        if (window.p86Markets && window.p86Markets.load) {
          window.p86Markets.load(true).then(function () {
            if (window.p86Markets.renderSwitcher) window.p86Markets.renderSwitcher();
          }).catch(function () {});
        }
      })
      .catch(function (e) {
        btn.disabled = false;
        if (errEl) errEl.textContent = (e && e.message) || 'Could not create market';
      });
  }

  // Permanent delete. Two-step ON PURPOSE: ask the server what is attached
  // BEFORE offering the button, because the FK is ON DELETE SET NULL — a
  // delete that "works" would quietly strip the market off live jobs, leads,
  // estimates and clients and leave no record of what they used to be.
  function deleteMarket(id) {
    var m = _markets.filter(function (x) { return String(x.id) === String(id); })[0];
    if (!m) return;
    window.p86Api.get('/api/markets/' + encodeURIComponent(id) + '/usage')
      .then(function (r) {
        var usage = (r && r.usage) || { total: 0, by_table: {} };
        if (!usage.total) {
          return window.p86Confirm({
            title: 'Delete ' + (m.name || 'market') + '?',
            message: 'Nothing is assigned to it. This removes the market permanently — it cannot be undone.',
            confirmText: 'Delete', cancelText: 'Cancel', destructive: true
          }).then(function (ok) { if (ok) doDelete(id, null); });
        }
        // In use → make the admin choose a destination. There is no sensible
        // default here: silently dumping records into "unassigned" is the very
        // data loss this dialog exists to prevent.
        var lines = Object.keys(usage.by_table).map(function (t) {
          return usage.by_table[t] + ' ' + t;
        }).join(', ');
        var others = _markets.filter(function (x) { return String(x.id) !== String(id); });
        var opts = others.map(function (x) {
          return '<option value="' + esc(x.id) + '">' + esc(x.name) + '</option>';
        }).join('') + '<option value="none">— leave them unassigned —</option>';
        var host = document.getElementById('admin-markets-host');
        var box = document.createElement('div');
        box.className = 'p86mk-new';
        box.innerHTML =
          '<div class="p86mk-delhead">Delete ' + esc(m.name) + ' — ' + usage.total + ' record' +
            (usage.total === 1 ? '' : 's') + ' still assigned</div>' +
          '<div class="p86mk-delsub">' + esc(lines) + '</div>' +
          '<div class="p86set-f"><label class="p86set-l">Move them to</label>' +
            '<select data-mk-to>' + opts + '</select>' +
            '<div class="p86set-h">Every record above is re-tagged first, then the market is removed. One transaction — if any part fails, nothing is deleted.</div>' +
          '</div>' +
          '<div class="p86mk-newbtns">' +
            '<button type="button" class="p86set-save" data-mk-godel>Move &amp; delete</button>' +
            '<button type="button" class="p86mk-cancel" data-mk-delcancel>Cancel</button>' +
            '<span class="p86mk-err" data-mk-err></span>' +
          '</div>';
        host.insertBefore(box, host.firstChild);
        box.querySelector('[data-mk-delcancel]').addEventListener('click', function () { paint(); });
        box.querySelector('[data-mk-godel]').addEventListener('click', function () {
          doDelete(id, box.querySelector('[data-mk-to]').value, box);
        });
      })
      .catch(function (e) {
        if (window.p86Toast) window.p86Toast('Could not read market usage: ' + ((e && e.message) || 'error'));
      });
  }

  function doDelete(id, reassignTo, box) {
    var q = '/api/markets/' + encodeURIComponent(id) + '?hard=1';
    if (reassignTo) q += '&reassign_to=' + encodeURIComponent(reassignTo);
    window.p86Api.del(q)
      .then(function () {
        _markets = _markets.filter(function (x) { return String(x.id) !== String(id); });
        _openId = null;
        paint();
        if (window.p86Markets && window.p86Markets.load) {
          window.p86Markets.load(true).then(function () {
            if (window.p86Markets.renderSwitcher) window.p86Markets.renderSwitcher();
          }).catch(function () {});
        }
      })
      .catch(function (e) {
        var el = box && box.querySelector('[data-mk-err]');
        var msg = (e && e.message) || 'Delete failed';
        if (el) el.textContent = msg; else if (window.p86Toast) window.p86Toast(msg);
      });
  }

  function toggleActive(id, act) {
    var m = _markets.filter(function (x) { return String(x.id) === String(id); })[0];
    if (!m) return;
    var off = act === 'off';
    var go = off
      ? window.p86Confirm({
          title: 'Deactivate ' + (m.name || 'market') + '?',
          message: 'It disappears from market pickers and the switcher. Jobs, leads and estimates already ' +
                   'assigned to it keep their assignment and keep resolving — nothing is deleted, and you ' +
                   'can reactivate it here at any time.',
          confirmText: 'Deactivate', cancelText: 'Cancel', destructive: true
        })
      : Promise.resolve(true);
    go.then(function (ok) {
      if (!ok) return;
      // DELETE is the deactivate verb server-side (active=FALSE); reactivating
      // is an ordinary PATCH back to active.
      var p = off
        ? window.p86Api.del('/api/markets/' + encodeURIComponent(id))
        : window.p86Api.patch('/api/markets/' + encodeURIComponent(id), { active: true });
      return p.then(function () {
        _markets = _markets.map(function (x) {
          return String(x.id) === String(id) ? Object.assign({}, x, { active: !off }) : x;
        });
        paint();
        if (window.p86Markets && window.p86Markets.load) {
          window.p86Markets.load(true).then(function () {
            if (window.p86Markets.renderSwitcher) window.p86Markets.renderSwitcher();
          }).catch(function () {});
        }
      });
    }).catch(function () {});
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
