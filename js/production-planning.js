// Production planning — the service manager's Thursday checklist.
//
// Lives in the Schedule area, beside the production calendar, because that is
// where John asked for it: "in our schedule area we'll have a production
// planning, and that will be where the service manager can go in and check off
// progress on the open service jobs before my WIP meeting".
//
// One sheet per meeting. Every open service job on it, grouped by property,
// each with how far along it is, a done tick and what is left. The manager's
// percent is the MANAGER'S percent — it never touches the job until somebody
// applies it, one row at a time, because a job's percent is derived from its
// scope lines and the scalar that caches it moves cost accrual and a figure an
// outside owner can see.
//
// The rules are all server-side (server/services/production-planning.js). This
// file renders and asks; it decides nothing about what may be seen or moved.
(function () {
  'use strict';

  var HOST = 'schedule-root';

  var _state = {
    list: [],          // the sheets
    current: null,     // { checklist, rows, summary, shares }
    loading: false,
    filter: 'all',     // all | idle | prog | done
    query: '',
    error: null,
  };

  // Debounced note saves, one timer per row — typing must not post per
  // keystroke, and two rows must not share a timer.
  var _noteTimers = {};

  function esc(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function money(n) {
    var v = Number(n);
    if (!isFinite(v)) return '';
    return '$' + Math.round(v).toLocaleString();
  }

  function when(ts) {
    if (!ts) return '';
    try {
      var d = new Date(ts);
      if (isNaN(d.getTime())) return '';
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' +
        d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    } catch (e) { return ''; }
  }

  // The dialogs. Native confirm() is a no-op inside the installed PWA, which
  // is why every guard in this app goes through the in-app overlay.
  function ask(message, opts) {
    var o = opts || {};
    if (typeof window.p86Confirm === 'function') {
      return window.p86Confirm({
        title: o.title || 'Confirm', message: message,
        confirmLabel: o.confirmLabel || 'Confirm', confirmText: o.confirmLabel || 'Confirm',
        cancelLabel: 'Cancel', cancelText: 'Cancel',
        danger: o.danger !== false, destructive: o.danger !== false,
      });
    }
    return Promise.resolve(window.confirm(message));
  }
  function toast(msg, kind) {
    if (typeof window.p86Toast === 'function') return window.p86Toast(msg, kind || 'info');
    if (typeof window.p86Alert === 'function') return window.p86Alert(msg);
    console.log('[production-planning] ' + msg);
  }

  // ── Server ───────────────────────────────────────────────────────────────
  function api(path, opts) {
    var o = opts || {};
    return fetch('/api/production-planning' + path, {
      method: o.method || 'GET',
      credentials: 'same-origin',
      headers: o.body ? { 'Content-Type': 'application/json' } : undefined,
      body: o.body ? JSON.stringify(o.body) : undefined,
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error((j && j.error) || ('HTTP ' + r.status));
        return j;
      });
    });
  }

  // ── Status of a row, from its percent ────────────────────────────────────
  function statusOf(row) {
    var p = Number(row && row.pct) || 0;
    return p >= 100 ? 'done' : p > 0 ? 'prog' : 'idle';
  }

  function visible(row) {
    if (_state.filter !== 'all' && statusOf(row) !== _state.filter) return false;
    if (!_state.query) return true;
    var hay = [row.job_number, row.job_title, row.client_label, row.address]
      .filter(Boolean).join(' ').toLowerCase();
    return hay.indexOf(_state.query) !== -1;
  }

  // ── Render ───────────────────────────────────────────────────────────────

  function render() {
    var root = document.getElementById(HOST);
    if (!root) return;
    root.innerHTML = '<div class="pp-page">' + renderBody() + '</div>';
    wire();
  }

  function renderBody() {
    if (_state.error) {
      return '<div class="pp-empty"><p>' + esc(_state.error) + '</p>' +
        '<button class="pp-btn" id="ppRetry">Try again</button></div>';
    }
    if (_state.loading && !_state.current) return '<div class="pp-empty"><p>Loading…</p></div>';
    if (!_state.current) return renderIndex();
    return renderSheet();
  }

  // The list of sheets, and the button that raises one.
  function renderIndex() {
    var h = '<header class="pp-head">' +
      '<div><h2 class="pp-title">Production planning</h2>' +
      '<p class="pp-sub">The service manager\'s checklist of open service jobs, for the WIP meeting.</p></div>' +
      '<button class="pp-btn pp-btn-primary" id="ppNew">+ New checklist</button>' +
      '</header>';
    if (!_state.list.length) {
      return h + '<div class="pp-empty"><p>No checklists yet.</p>' +
        '<p class="pp-dim">A new one picks up every open Service and Mid-Tier job as it stands right now.</p></div>';
    }
    h += '<ul class="pp-index">';
    _state.list.forEach(function (c) {
      h += '<li class="pp-index-row" data-open="' + esc(c.id) + '">' +
        '<div class="pp-index-main">' +
          '<span class="pp-index-title">' + esc(c.title) + '</span>' +
          (c.status === 'closed' ? '<span class="pp-pill pp-pill-idle">Closed</span>' : '') +
        '</div>' +
        '<div class="pp-index-meta">' +
          (c.meeting_date ? 'Meeting ' + esc(String(c.meeting_date).slice(0, 10)) + ' · ' : '') +
          esc(String(c.row_count || 0)) + ' job' + (Number(c.row_count) === 1 ? '' : 's') +
        '</div>' +
      '</li>';
    });
    return h + '</ul>';
  }

  function renderSheet() {
    var c = _state.current.checklist;
    var rows = _state.current.rows || [];
    var s = _state.current.summary || { done: 0, in_progress: 0, not_started: 0, overall_pct: 0 };

    var h = '<header class="pp-head">' +
      '<div>' +
        '<button class="pp-back" id="ppBack">&larr; All checklists</button>' +
        '<h2 class="pp-title">' + esc(c.title) + '</h2>' +
        '<p class="pp-sub">' +
          (c.meeting_date ? 'For the meeting on ' + esc(String(c.meeting_date).slice(0, 10)) + ' · ' : '') +
          rows.length + ' open service job' + (rows.length === 1 ? '' : 's') +
        '</p>' +
      '</div>' +
      '<div class="pp-head-actions">' +
        '<button class="pp-btn" id="ppSync" title="Add any job that has opened since this checklist was made. Nothing is ever removed.">Refresh jobs</button>' +
        '<button class="pp-btn" id="ppShare">Send to…</button>' +
      '</div>' +
    '</header>';

    // The tally bar.
    h += '<div class="pp-tally">' +
      '<div class="pp-stat pp-stat-done"><b>' + s.done + '</b><span>Done</span></div>' +
      '<div class="pp-stat pp-stat-prog"><b>' + s.in_progress + '</b><span>In progress</span></div>' +
      '<div class="pp-stat"><b>' + s.not_started + '</b><span>Not started</span></div>' +
      '<div class="pp-overall">' +
        '<span class="pp-dim">Overall ' + s.overall_pct + '% complete</span>' +
        '<div class="pp-bar"><i style="width:' + s.overall_pct + '%"></i></div>' +
      '</div>' +
    '</div>';

    h += '<div class="pp-controls">' +
      ['all', 'idle', 'prog', 'done'].map(function (f) {
        var label = f === 'all' ? 'All' : f === 'idle' ? 'Not started' : f === 'prog' ? 'In progress' : 'Done';
        return '<button class="pp-chip" data-filter="' + f + '" aria-pressed="' +
          (_state.filter === f ? 'true' : 'false') + '">' + label + '</button>';
      }).join('') +
      '<input id="ppQuery" class="pp-search" type="search" placeholder="Search job, address, property" ' +
        'value="' + esc(_state.query) + '" aria-label="Search the checklist">' +
    '</div>';

    // Grouped by property. The heading is the client text snapshotted when
    // the sheet was raised, which is what the reference design groups on.
    var groups = {};
    rows.forEach(function (r) {
      var k = r.client_label || 'No property';
      (groups[k] = groups[k] || []).push(r);
    });
    var names = Object.keys(groups).sort(function (a, b) { return a.localeCompare(b); });
    var anyVisible = false;

    names.forEach(function (name) {
      var list = groups[name].filter(visible);
      if (!list.length) return;
      anyVisible = true;
      var done = groups[name].filter(function (r) { return statusOf(r) === 'done'; }).length;
      h += '<section class="pp-group">' +
        '<h3 class="pp-group-head"><span>' + esc(name) + '</span>' +
          '<small>' + done + ' of ' + groups[name].length + ' done</small></h3>';
      list.forEach(function (r) { h += renderRow(r); });
      h += '</section>';
    });

    if (!anyVisible) h += '<div class="pp-empty"><p>No jobs match this filter.</p></div>';
    return h;
  }

  function renderRow(r) {
    var st = statusOf(r);
    var pct = Number(r.pct) || 0;
    var addr = r.address || '';
    // The STREET only. Grouped by property, the city/state/zip is noise on
    // every row — it was costing a whole wrapped line each, and 40 of those
    // is most of a screen. The link still carries the full address.
    var street = addr.split(',')[0].trim() || addr;
    var mapHtml = '';
    if (addr && window.p86MapLink && typeof window.p86MapLink.linkHTML === 'function') {
      mapHtml = window.p86MapLink.linkHTML(addr, { iconOnly: false, label: street });
      // p86MapLink labels with the full address; swap in the street without
      // touching the href, which is what the maps deep link needs.
      if (mapHtml.indexOf(esc(addr)) !== -1) {
        mapHtml = mapHtml.replace(esc(addr), esc(street));
      }
    } else if (addr) {
      mapHtml = esc(street);
    }

    return '<article class="pp-row' + (st === 'done' ? ' is-done' : '') + '" data-row="' + esc(r.id) + '">' +
      '<button class="pp-check" data-act="toggle" aria-pressed="' + (st === 'done') + '" ' +
        'aria-label="' + (st === 'done' ? 'Mark not done' : 'Mark done') + '">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" ' +
        'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M5 12.5l4.5 4.5L19 7.5"/></svg>' +
      '</button>' +
      '<div class="pp-row-main">' +
        '<div class="pp-row-top">' +
          '<span class="pp-num">' + esc(r.job_number || '') + '</span>' +
          '<span class="pp-name">' + esc(r.job_title || '') + '</span>' +
          (r.is_work_order ? '<span class="pp-tag">WO</span>' : '') +
          // A contract of zero is not a contract — most work orders have none,
          // and printing $0 on half the sheet is noise that reads as a number.
          (Number(r.contract_amount) > 0
            ? '<span class="pp-contract" title="Contract value">' + esc(money(r.contract_amount)) + '</span>' : '') +
          // The address rides the title line rather than taking one of its
          // own. It wraps to its own line when there is no room, which is the
          // only time it needs one.
          (mapHtml ? '<span class="pp-addr">' + mapHtml + '</span>' : '') +
          '<span class="pp-pill pp-pill-' + st + '">' +
            (st === 'done' ? 'Done' : st === 'prog' ? pct + '%' : 'Not started') + '</span>' +
        '</div>' +
        '<div class="pp-progress">' +
          '<div class="pp-steps" role="group" aria-label="Percent complete">' +
            [0, 25, 50, 75, 100].map(function (p) {
              return '<button data-act="pct" data-pct="' + p + '" aria-pressed="' +
                (pct === p ? 'true' : 'false') + '">' + p + '%</button>';
            }).join('') +
          '</div>' +
          '<div class="pp-mini"><div class="pp-bar"><i style="width:' + pct + '%"></i></div></div>' +
          '<span class="pp-dim pp-who">' +
            (r.updated_at ? 'Updated ' + esc(when(r.updated_at)) +
              (r.updated_actor ? ' by ' + esc(r.updated_actor) : '') : '') +
          '</span>' +
          (r.applied_at
            ? '<span class="pp-applied" title="This percent is on the job\'s scope line">&#10003; applied</span>'
            : '<button class="pp-btn pp-btn-sm" data-act="apply" title="Write this percent onto the job\'s scope line, so the WIP picks it up">Apply to WIP</button>') +
        '</div>' +
        '<textarea class="pp-note" data-act="note" rows="1" placeholder="What\'s left">' +
          esc(r.note || '') + '</textarea>' +
      '</div>' +
    '</article>';
  }

  // ── Wiring ───────────────────────────────────────────────────────────────

  function wire() {
    var root = document.getElementById(HOST);
    if (!root) return;

    var retry = document.getElementById('ppRetry');
    if (retry) retry.addEventListener('click', function () { _state.error = null; load(); });

    var nw = document.getElementById('ppNew');
    if (nw) nw.addEventListener('click', createChecklist);

    var back = document.getElementById('ppBack');
    if (back) back.addEventListener('click', function () {
      _state.current = null;
      if (window.p86Router && typeof window.p86Router.navigate === 'function') {
        try { window.p86Router.navigate({ top: 'schedule', sub: 'planning' }); } catch (e) { /* no-op */ }
      }
      load();
    });

    var sync = document.getElementById('ppSync');
    if (sync) sync.addEventListener('click', syncJobs);

    var share = document.getElementById('ppShare');
    if (share) share.addEventListener('click', openShare);

    root.querySelectorAll('[data-open]').forEach(function (el) {
      el.addEventListener('click', function () { open(el.getAttribute('data-open')); });
    });

    root.querySelectorAll('.pp-chip').forEach(function (b) {
      b.addEventListener('click', function () {
        _state.filter = b.getAttribute('data-filter');
        render();
      });
    });

    var q = document.getElementById('ppQuery');
    if (q) {
      q.addEventListener('input', function () {
        _state.query = String(q.value || '').trim().toLowerCase();
        var at = q.selectionStart;
        render();
        var again = document.getElementById('ppQuery');
        if (again) { again.focus(); try { again.setSelectionRange(at, at); } catch (e) { /* no-op */ } }
      });
    }

    root.querySelectorAll('.pp-row').forEach(function (el) {
      var rowId = el.getAttribute('data-row');
      el.querySelectorAll('[data-act]').forEach(function (c) {
        var act = c.getAttribute('data-act');
        if (act === 'toggle') {
          c.addEventListener('click', function () { patchRow(rowId, { done: !rowDone(rowId) }); });
        } else if (act === 'pct') {
          c.addEventListener('click', function () {
            patchRow(rowId, { pct: Number(c.getAttribute('data-pct')) });
          });
        } else if (act === 'apply') {
          c.addEventListener('click', function () { applyRow(rowId); });
        } else if (act === 'note') {
          c.addEventListener('input', function () {
            clearTimeout(_noteTimers[rowId]);
            _noteTimers[rowId] = setTimeout(function () {
              patchRow(rowId, { note: c.value }, { quiet: true });
            }, 900);
          });
          c.addEventListener('blur', function () {
            clearTimeout(_noteTimers[rowId]);
            if ((rowOf(rowId) || {}).note !== c.value) patchRow(rowId, { note: c.value }, { quiet: true });
          });
        }
      });
    });
  }

  function rowOf(id) {
    return ((_state.current && _state.current.rows) || []).filter(function (r) { return r.id === id; })[0];
  }
  function rowDone(id) {
    var r = rowOf(id);
    return !!(r && r.done);
  }

  // ── Actions ──────────────────────────────────────────────────────────────

  function load() {
    _state.loading = true;
    render();
    return api('/').then(function (j) {
      _state.list = j.checklists || [];
      _state.loading = false;
      render();
    }).catch(function (e) {
      _state.loading = false;
      _state.error = e.message || 'Could not load the checklists.';
      render();
    });
  }

  function open(id) {
    _state.loading = true;
    render();
    return api('/' + encodeURIComponent(id)).then(function (j) {
      _state.current = j;
      _state.loading = false;
      if (window.p86Router && typeof window.p86Router.navigate === 'function') {
        try { window.p86Router.navigate({ top: 'schedule', sub: 'planning', id: id }); } catch (e) { /* no-op */ }
      }
      render();
    }).catch(function (e) {
      _state.loading = false;
      _state.error = e.message || 'Could not open that checklist.';
      render();
    });
  }

  function createChecklist() {
    var today = new Date();
    var title = 'Production planning — ' + today.toISOString().slice(0, 10);
    api('/', { method: 'POST', body: { title: title } }).then(function (j) {
      toast('Checklist created with ' + (j.added || 0) + ' open job' + (j.added === 1 ? '' : 's') + '.', 'success');
      _state.current = { checklist: j.checklist, rows: j.rows || [], summary: null, shares: [] };
      return open(j.checklist.id);
    }).catch(function (e) { toast(e.message || 'Could not create the checklist.', 'error'); });
  }

  function syncJobs() {
    var c = _state.current && _state.current.checklist;
    if (!c) return;
    api('/' + encodeURIComponent(c.id) + '/sync', { method: 'POST' }).then(function (j) {
      toast(j.added ? ('Added ' + j.added + ' job' + (j.added === 1 ? '' : 's') + '.') : 'Nothing new to add.', 'success');
      return open(c.id);
    }).catch(function (e) { toast(e.message || 'Could not refresh.', 'error'); });
  }

  function patchRow(rowId, patch, opts) {
    var o = opts || {};
    var c = _state.current && _state.current.checklist;
    if (!c) return;
    return api('/' + encodeURIComponent(c.id) + '/rows/' + encodeURIComponent(rowId),
      { method: 'PUT', body: patch }
    ).then(function (j) {
      var rows = _state.current.rows || [];
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].id === j.row.id) { rows[i] = j.row; break; }
      }
      _state.current.summary = summarize(rows);
      render();
    }).catch(function (e) {
      if (!o.quiet) toast(e.message || 'Could not save.', 'error');
    });
  }

  // Mirrors the server's summarize(). The server's answer is authoritative on
  // load; this keeps the tally honest between round trips.
  function summarize(rows) {
    var done = 0, prog = 0, idle = 0, sum = 0;
    (rows || []).forEach(function (r) {
      var p = Number(r.pct) || 0;
      sum += p;
      if (p >= 100) done++; else if (p > 0) prog++; else idle++;
    });
    return {
      total: (rows || []).length, done: done, in_progress: prog, not_started: idle,
      overall_pct: (rows || []).length ? Math.round(sum / rows.length) : 0,
    };
  }

  function applyRow(rowId) {
    var c = _state.current && _state.current.checklist;
    var r = rowOf(rowId);
    if (!c || !r) return;
    ask('Write ' + (Number(r.pct) || 0) + '% onto ' + (r.job_number || 'this job') +
        '’s scope line? The WIP will pick it up.',
        { title: 'Apply to WIP', confirmLabel: 'Apply', danger: false }
    ).then(function (yes) {
      if (!yes) return;
      return api('/' + encodeURIComponent(c.id) + '/rows/' + encodeURIComponent(rowId) + '/apply',
        { method: 'POST' }
      ).then(function (j) {
        _state.current.rows = j.rows || _state.current.rows;
        _state.current.summary = summarize(_state.current.rows);
        toast((r.job_number || 'Job') + ' is now ' + Math.round(j.job_pct) + '% on the WIP.', 'success');
        render();
        // The job's money just moved, so the surfaces that show it repaint.
        if (typeof window.p86Refresh === 'function') window.p86Refresh('job', { id: r.job_id });
      }).catch(function (e) {
        // A job with several scope lines refuses and NAMES them rather than
        // inventing a split. Offer the choice instead of swallowing it.
        toast(e.message || 'Could not apply.', 'error');
      });
    });
  }

  function openShare() {
    var c = _state.current && _state.current.checklist;
    if (!c) return;
    ask('Create a link to this checklist? Whoever has it can update how far along each job is — ' +
        'no login needed. It expires in 30 days and you can turn it off at any time.',
        { title: 'Send to…', confirmLabel: 'Create link', danger: false }
    ).then(function (yes) {
      if (!yes) return;
      return api('/' + encodeURIComponent(c.id) + '/shares',
        { method: 'POST', body: { scope: 'update', days: 30 } }
      ).then(function (j) {
        var url = window.location.origin + j.url;
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(url).then(function () {
            toast('Link copied to the clipboard.', 'success');
          }, function () { toast(url, 'info'); });
        } else {
          toast(url, 'info');
        }
      });
    }).catch(function (e) { toast(e.message || 'Could not create the link.', 'error'); });
  }

  // ── Entry points ─────────────────────────────────────────────────────────

  // Called by js/schedule.js when the Planning sub-view is active, and by the
  // router when a /schedule/planning link is opened.
  function renderPlanning(opts) {
    var o = opts || {};
    _state.error = null;
    if (o.id) return open(o.id);
    if (_state.current) return render();
    return load();
  }

  function refresh() {
    if (_state.current && _state.current.checklist) return open(_state.current.checklist.id);
    return load();
  }

  window.p86ProductionPlanning = {
    render: renderPlanning,
    refresh: refresh,
    // Exposed so the router can tell whether a sheet is already on screen.
    currentId: function () {
      return (_state.current && _state.current.checklist && _state.current.checklist.id) || null;
    },
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { statusOf: statusOf, summarize: summarize };
  }
})();
