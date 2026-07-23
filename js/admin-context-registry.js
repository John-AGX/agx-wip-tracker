// Promise confirm. Native confirm() returns undefined inside an installed PWA,
// so every `if (!confirm(x)) return` guard silently did nothing there: the
// dialog never appeared and the action never ran. Uses the in-app overlay when
// present, native only as a fallback.
function p86Ask(message, opts) {
  opts = opts || {};
  if (typeof window.p86Confirm === 'function') {
    return window.p86Confirm({
      title: opts.title || 'Confirm', message: message,
      confirmLabel: opts.confirmLabel || 'Confirm', confirmText: opts.confirmLabel || 'Confirm',
      cancelLabel: 'Cancel', cancelText: 'Cancel',
      danger: opts.danger !== false, destructive: opts.danger !== false
    });
  }
  return Promise.resolve(window.confirm(message));
}
// Wave 1.B — Context Registry admin page.
//
// Reads the four /api/admin/context-registry/* endpoints (server side
// in routes/context-registry-routes.js) and paints a per-layer
// observability view: load counts, top items, stale items, drilldown
// timeline.
//
// Design intent: this is an OBSERVATION surface. No mutations. The
// natural extensions later (archive stale memory from this page,
// edit a dormant skill) get added as Wave 1.B Phase 2 once the
// initial picture proves out.

(function() {
  'use strict';

  var _state = {
    days: 7,
    summary: null,
    stale: null,
    selectedLayer: null
  };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function fmtTs(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleString();
  }
  function fmtAgo(iso) {
    if (!iso) return 'never';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return 'never';
    var ms = Date.now() - d.getTime();
    if (ms < 60000) return 'just now';
    if (ms < 3600000) return Math.floor(ms / 60000) + 'm ago';
    if (ms < 86400000) return Math.floor(ms / 3600000) + 'h ago';
    return Math.floor(ms / 86400000) + 'd ago';
  }

  // Layer-name → display label + icon glyph. Free text on server, so
  // we render any unknown layer too (just without a friendly label).
  var LAYER_LABELS = {
    memory:         { label: 'Memory',     glyph: '🧠', desc: 'Memories recalled in this window' },
    entity_read:    { label: 'Entity Read', glyph: '📄', desc: 'read_entity calls (jobs/clients/leads/estimates)' },
    entity_search:  { label: 'Entity Search', glyph: '🔍', desc: 'search_entities calls (with filters)' },
    skill:          { label: 'Skill',      glyph: '🎯', desc: 'Skill-pack invocations (when Anthropic reports them)' },
    watch:          { label: 'Watch',      glyph: '⏰', desc: 'Background watcher fires' },
    turn_context:   { label: 'Turn Context', glyph: '📋', desc: 'Bundled context per turn' },
    wave3:          { label: 'Wave 3',    glyph: '📝', desc: 'RFI / submittal / transmittal / compliance reads' }
  };

  function loadAll() {
    var host = document.getElementById('admin-subtab-context');
    if (!host) return;
    host.innerHTML = '<div style="padding:24px;color:#888;">Loading context registry…</div>';

    Promise.all([
      window.p86Api.get('/api/admin/context-registry/summary?days=' + _state.days),
      window.p86Api.get('/api/admin/context-registry/stale?layer=memory&days=' + _state.days)
    ]).then(function(results) {
      _state.summary = results[0];
      _state.stale = results[1];
      paint();
    }).catch(function(err) {
      host.innerHTML = '<div style="padding:24px;color:#f87171;">' +
        'Failed to load registry: ' + esc(err && err.message || err) + '</div>';
    });
  }

  function paint() {
    var host = document.getElementById('admin-subtab-context');
    if (!host) return;

    var html = '';

    // Header — title, window selector, refresh.
    html += '<div style="padding:14px 16px;border-bottom:1px solid var(--border,#2a2a32);display:flex;align-items:center;gap:12px;">';
    html += '<div style="flex:1;">';
    html += '<div style="font-size:13px;font-weight:700;color:var(--text,#fff);letter-spacing:0.3px;">Context Registry</div>';
    html += '<div style="font-size:11px;color:var(--text-dim,#888);margin-top:2px;">Observability across memory / skill / watch / entity-read layers. ' +
            '<a href="#" data-context-help="1" style="color:#4f8cff;text-decoration:none;">What\'s this?</a></div>';
    html += '</div>';
    html += '<select data-context-days style="background:var(--card-bg,#141419);border:1px solid var(--border,#2a2a32);color:var(--text,#fff);padding:6px 10px;border-radius:6px;font-size:12px;">';
    [1, 7, 30, 90].forEach(function(d) {
      html += '<option value="' + d + '"' + (d === _state.days ? ' selected' : '') + '>Last ' + d + 'd</option>';
    });
    html += '</select>';
    html += '<button data-context-refresh style="background:#4f8cff;border:none;color:white;padding:7px 14px;border-radius:6px;font-size:12px;cursor:pointer;">Refresh</button>';
    html += '</div>';

    // Layer rollup grid.
    html += '<div style="padding:14px 16px;display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:10px;">';
    var layers = (_state.summary && _state.summary.layers) || [];
    if (!layers.length) {
      html += '<div style="grid-column:1/-1;padding:24px;text-align:center;color:var(--text-dim,#888);font-style:italic;">';
      html += 'No context-load events recorded in the last ' + _state.days + ' days.<br>';
      html += '<span style="font-size:11px;">Use the AI chat — memory recalls and entity reads will appear here.</span>';
      html += '</div>';
    } else {
      layers.forEach(function(L) {
        var meta = LAYER_LABELS[L.layer] || { label: L.layer, glyph: '•', desc: '' };
        html += '<div data-layer-card="' + esc(L.layer) + '" style="background:var(--card-bg,#141419);border:1px solid var(--border,#2a2a32);border-radius:8px;padding:12px;cursor:pointer;transition:border-color 0.15s;">';
        html += '<div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">';
        html += '<span style="font-size:18px;">' + meta.glyph + '</span>';
        html += '<div style="flex:1;"><div style="font-size:12px;font-weight:700;color:var(--text,#fff);">' + esc(meta.label) + '</div>';
        html += '<div style="font-size:10px;color:var(--text-dim,#888);">' + esc(meta.desc || L.layer) + '</div></div>';
        html += '</div>';
        html += '<div style="display:flex;align-items:baseline;gap:14px;margin-top:8px;">';
        html += '<div><div style="font-size:18px;font-weight:700;color:#34d399;font-family:\'Courier New\',monospace;">' + L.load_count + '</div><div style="font-size:9px;color:var(--text-dim,#888);text-transform:uppercase;letter-spacing:0.5px;">Loads</div></div>';
        html += '<div><div style="font-size:18px;font-weight:700;color:#4f8cff;font-family:\'Courier New\',monospace;">' + L.distinct_items + '</div><div style="font-size:9px;color:var(--text-dim,#888);text-transform:uppercase;letter-spacing:0.5px;">Distinct</div></div>';
        html += '<div style="flex:1;text-align:right;"><div style="font-size:10px;color:var(--text-dim,#888);">Most recent</div><div style="font-size:10px;color:var(--text-dim,#aaa);">' + fmtAgo(L.most_recent_load) + '</div></div>';
        html += '</div>';
        // Top 3 items inline.
        if (L.top_items && L.top_items.length) {
          html += '<div style="margin-top:10px;padding-top:8px;border-top:1px solid var(--ng-border2,#2a2a32);">';
          L.top_items.slice(0, 3).forEach(function(it) {
            html += '<div style="display:flex;align-items:center;gap:8px;padding:2px 0;font-size:11px;color:var(--text-dim,#aaa);">';
            html += '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(it.item_name || it.item_id || '(unnamed)') + '</span>';
            html += '<span style="color:#fbbf24;font-family:\'Courier New\',monospace;">' + it.load_count + '×</span>';
            html += '</div>';
          });
          html += '</div>';
        }
        html += '</div>';
      });
    }
    html += '</div>';

    // Stale memories block.
    html += '<div style="padding:14px 16px;">';
    html += '<div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:8px;">';
    html += '<div style="font-size:12px;font-weight:700;color:var(--text,#fff);">Dormant memories</div>';
    html += '<div style="font-size:10px;color:var(--text-dim,#888);">Not recalled in the last ' + _state.days + ' days</div>';
    html += '</div>';

    var stale = (_state.stale && _state.stale.stale_items) || [];
    if (!stale.length) {
      html += '<div style="padding:14px;background:var(--card-bg,#141419);border:1px solid var(--border,#2a2a32);border-radius:6px;font-size:11px;color:var(--text-dim,#888);font-style:italic;">';
      html += 'Every active memory has been recalled in the window. Healthy registry.';
      html += '</div>';
    } else {
      html += '<div style="background:var(--card-bg,#141419);border:1px solid var(--border,#2a2a32);border-radius:6px;overflow:hidden;">';
      html += '<div style="display:grid;grid-template-columns:1fr 70px 50px 90px 60px;gap:8px;padding:8px 12px;background:rgba(124,58,237,0.08);border-bottom:1px solid var(--border,#2a2a32);font-size:10px;color:var(--text-dim,#aaa);text-transform:uppercase;letter-spacing:0.5px;">';
      html += '<div>Memory</div><div>Kind</div><div style="text-align:right;">Imp</div><div style="text-align:right;">Last recall</div><div></div>';
      html += '</div>';
      stale.forEach(function(m) {
        html += '<div style="display:grid;grid-template-columns:1fr 70px 50px 90px 60px;gap:8px;padding:8px 12px;border-bottom:1px solid var(--ng-border2,#2a2a32);font-size:11px;color:var(--text,#fff);align-items:center;">';
        html += '<div><span style="font-weight:600;">' + esc(m.topic) + '</span><span style="color:var(--text-dim,#888);font-size:10px;"> [' + esc(m.scope) + ']</span></div>';
        html += '<div style="color:var(--text-dim,#aaa);">' + esc(m.kind) + '</div>';
        html += '<div style="text-align:right;color:#fbbf24;font-family:\'Courier New\',monospace;">' + m.importance + '</div>';
        html += '<div style="text-align:right;color:var(--text-dim,#888);">' + fmtAgo(m.last_recalled_at) + '</div>';
        html += '<div style="text-align:right;">';
        html += '<button data-archive-memory="' + esc(m.id) + '" data-archive-topic="' + esc(m.topic) + '" title="Archive this memory — it stops surfacing on recall" style="background:transparent;border:1px solid var(--border,#2a2a32);color:#f87171;padding:3px 8px;border-radius:4px;font-size:10px;cursor:pointer;">Archive</button>';
        html += '</div>';
        html += '</div>';
      });
      html += '</div>';
    }
    html += '</div>';

    host.innerHTML = html;
    wireEvents(host);
  }

  function wireEvents(host) {
    var select = host.querySelector('[data-context-days]');
    if (select) {
      select.addEventListener('change', function() {
        _state.days = Number(this.value) || 7;
        loadAll();
      });
    }
    var refresh = host.querySelector('[data-context-refresh]');
    if (refresh) refresh.addEventListener('click', loadAll);
    var helpLink = host.querySelector('[data-context-help]');
    if (helpLink) {
      helpLink.addEventListener('click', function(e) {
        e.preventDefault();
        alert(
          'The Context Registry tracks every piece of context that loaded for the AI:\n\n' +
          '• Memory — when 86 recalls a saved memory\n' +
          '• Entity Read — when 86 fetches a full job/client/lead/estimate\n' +
          '• Entity Search — when 86 searches with a filter\n' +
          '• Skill / Watch / Turn Context — when those layers fire\n\n' +
          'Use the "Dormant memories" list to see which saved memories aren\'t earning their keep and could be pruned.\n\n' +
          'No data here yet? Use the AI chat — it populates as 86 uses tools.'
        );
      });
    }
    // Click on a layer card → open drilldown modal with recent events.
    host.querySelectorAll('[data-layer-card]').forEach(function(card) {
      card.addEventListener('mouseenter', function() { card.style.borderColor = '#4f8cff'; });
      card.addEventListener('mouseleave', function() { card.style.borderColor = ''; });
      card.addEventListener('click', function() {
        var layer = card.getAttribute('data-layer-card');
        openLayerDrilldown(layer);
      });
    });

    // Archive buttons on dormant memories.
    host.querySelectorAll('[data-archive-memory]').forEach(function(btn) {
      btn.addEventListener('click', async function(e) {
        e.stopPropagation();
        var id = btn.getAttribute('data-archive-memory');
        var topic = btn.getAttribute('data-archive-topic');
        if (!(await p86Ask('Archive memory "' + topic + '"? It stops surfacing on recall.'))) return;
        btn.disabled = true; btn.textContent = '…';
        window.p86Api.post('/api/admin/context-registry/memory/' + encodeURIComponent(id) + '/archive', {})
          .then(function() { loadAll(); })
          .catch(function(err) {
            alert('Archive failed: ' + (err && err.message || err));
            btn.disabled = false; btn.textContent = 'Archive';
          });
      });
    });
  }

  // Drilldown modal — recent events + per-item rollup for one layer.
  // Reads /items?layer=X&days=N. Closes on backdrop click or Esc.
  function openLayerDrilldown(layer) {
    var meta = LAYER_LABELS[layer] || { label: layer, glyph: '•' };
    var prior = document.getElementById('contextDrilldown');
    if (prior) prior.remove();

    var modal = document.createElement('div');
    modal.id = 'contextDrilldown';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.65);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;';
    modal.innerHTML =
      '<div style="background:var(--card-bg,#141419);border:1px solid var(--border,#2a2a32);border-radius:10px;max-width:780px;width:100%;max-height:85vh;display:flex;flex-direction:column;overflow:hidden;">' +
        '<div style="padding:14px 18px;border-bottom:1px solid var(--border,#2a2a32);display:flex;align-items:center;gap:12px;">' +
          '<span style="font-size:22px;">' + meta.glyph + '</span>' +
          '<div style="flex:1;"><div style="font-size:14px;font-weight:700;color:var(--text,#fff);">' + esc(meta.label) + ' — drilldown</div>' +
          '<div style="font-size:11px;color:var(--text-dim,#888);">Recent load events in the last ' + _state.days + ' days</div></div>' +
          '<button data-context-modal-close style="background:transparent;border:none;color:var(--text-dim,#888);font-size:24px;cursor:pointer;line-height:1;">&times;</button>' +
        '</div>' +
        '<div data-drilldown-body style="flex:1;overflow-y:auto;padding:14px 18px;">Loading…</div>' +
      '</div>';
    document.body.appendChild(modal);

    function close() { modal.remove(); document.removeEventListener('keydown', onKey); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);
    modal.addEventListener('click', function(e) { if (e.target === modal) close(); });
    modal.querySelector('[data-context-modal-close]').addEventListener('click', close);

    var body = modal.querySelector('[data-drilldown-body]');
    window.p86Api.get('/api/admin/context-registry/items?layer=' + encodeURIComponent(layer) + '&days=' + _state.days + '&limit=200')
      .then(function(resp) {
        var events = (resp && resp.events) || [];
        if (!events.length) {
          body.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text-dim,#888);font-style:italic;">No events for this layer in the window.</div>';
          return;
        }
        var html = '<table style="width:100%;border-collapse:collapse;font-size:11px;">';
        html += '<thead><tr style="color:var(--text-dim,#aaa);text-transform:uppercase;font-size:9px;letter-spacing:0.5px;">';
        html += '<th style="text-align:left;padding:6px 4px;border-bottom:1px solid var(--border,#2a2a32);">When</th>';
        html += '<th style="text-align:left;padding:6px 4px;border-bottom:1px solid var(--border,#2a2a32);">Item</th>';
        html += '<th style="text-align:left;padding:6px 4px;border-bottom:1px solid var(--border,#2a2a32);">User</th>';
        html += '<th style="text-align:left;padding:6px 4px;border-bottom:1px solid var(--border,#2a2a32);">Meta</th>';
        html += '</tr></thead><tbody>';
        events.forEach(function(e) {
          var metaSnippet = '';
          if (e.item_meta && typeof e.item_meta === 'object') {
            try {
              metaSnippet = Object.keys(e.item_meta).map(function(k) {
                var v = e.item_meta[k];
                if (v == null) return null;
                if (typeof v === 'object') v = JSON.stringify(v);
                return k + '=' + String(v).slice(0, 30);
              }).filter(Boolean).join(' · ');
            } catch (_) {}
          }
          html += '<tr style="color:var(--text,#fff);">';
          html += '<td style="padding:6px 4px;border-bottom:1px solid var(--ng-border2,#1e2233);color:var(--text-dim,#aaa);white-space:nowrap;" title="' + esc(fmtTs(e.loaded_at)) + '">' + esc(fmtAgo(e.loaded_at)) + '</td>';
          html += '<td style="padding:6px 4px;border-bottom:1px solid var(--ng-border2,#1e2233);"><span style="font-weight:600;">' + esc(e.item_name || e.item_id || '(no name)') + '</span></td>';
          html += '<td style="padding:6px 4px;border-bottom:1px solid var(--ng-border2,#1e2233);color:var(--text-dim,#aaa);">' + esc(e.user_email || '—') + '</td>';
          html += '<td style="padding:6px 4px;border-bottom:1px solid var(--ng-border2,#1e2233);color:var(--text-dim,#888);font-size:10px;">' + esc(metaSnippet) + '</td>';
          html += '</tr>';
        });
        html += '</tbody></table>';
        body.innerHTML = html;
      })
      .catch(function(err) {
        body.innerHTML = '<div style="padding:24px;color:#f87171;">Failed to load: ' + esc(err && err.message || err) + '</div>';
      });
  }

  // Expose to admin.js dispatch.
  window.renderAdminContextRegistry = loadAll;
})();
