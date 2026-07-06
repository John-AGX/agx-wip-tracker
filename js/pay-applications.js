// ============================================================
// AGX Project 86 — Applications for Payment (AIA G702 / G703)
// ============================================================
// The periodic progress-billing screen. Mounts as the job "Billing"
// section: window.renderPayApps(jobId) is called by switchJobSubTab
// (legacy panes) and by the Site Plan inspector via WS_SECTION_RENDERERS
// (nodegraph/ui.js) — the map-as-job-page surface.
//
// SCHEDULE OF VALUES (G703): derived from the job's node graph when a NEW
// application is created — each phase→building allocation (NG.getPhaseRevenue-
// ToBuilding) and each CO→parent allocation (NG.getCOIncomeToParent) becomes
// one SOV line with its scheduled (contract) value. Once created the lines are
// FROZEN into the pay_applications row (data.lines[]); the server carries each
// line's "previous" (prior period's completed-and-stored) forward so the G703
// draw math is correct without the client tracking history.
//
// BILLING MODEL (documented v1 choice): the editable driver per line is
// cumulative % complete (Option A — % drives the billing; levels/units feed
// the % in a later slice). Materials-presently-stored (F) and a per-line
// retainage rate are the two extra columns John approved.
//   G (total completed & stored) = scheduledValue × pct/100 + stored
//   previous (D, carried by server) = prior period's G
//   this period (E, the draw)       = G − previous
//   retainage                        = retPct% × G   (per-line rate or app default)
//   % (of contract)                  = G / scheduledValue
//   balance to finish                = scheduledValue − G
// Current payment due (G702) = Σ(this-period) less retainage. Reconciles
// exactly because previous carries the prior G.
(function () {
  'use strict';

  // ── helpers ───────────────────────────────────────────────
  function esc(s) {
    if (s == null) return '';
    if (typeof window.escapeHTML === 'function') return window.escapeHTML(String(s));
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function fmtC(n) {
    n = num(n);
    var neg = n < 0, a = Math.abs(n);
    return (neg ? '-$' : '$') + a.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtPct(n) { n = num(n); return (Math.round(n * 10) / 10) + '%'; }
  function round2(n) { return Math.round(num(n) * 100) / 100; }
  function todayISO() {
    try { return new Date().toISOString().slice(0, 10); } catch (e) { return ''; }
  }
  function fmtDate(iso) {
    if (!iso) return '—';
    var s = String(iso).slice(0, 10), p = s.split('-');
    if (p.length === 3) return p[1] + '/' + p[2] + '/' + p[0];
    return s;
  }

  // ── module state ──────────────────────────────────────────
  var _st = { jobId: null, apps: [], currentId: null, loading: false, saving: false,
              dirty: false, error: null };
  var _saveTimer = null;

  function currentApp() {
    return _st.apps.find(function (a) { return a.id === _st.currentId; }) || null;
  }
  function jobCanEdit() {
    try {
      var j = (window.appData && appData.jobs) ? appData.jobs.find(function (x) { return x.id === _st.jobId; }) : null;
      return !j || j._canEdit !== false;
    } catch (e) { return true; }
  }
  function appEditable(app) {
    if (!app) return false;
    if (app.status === 'certified' || app.status === 'paid') return false;
    return jobCanEdit();
  }

  // ── per-line + summary math ───────────────────────────────
  function lineRetPct(l, app) {
    if (l && l.retainagePct != null && l.retainagePct !== '') return num(l.retainagePct);
    return app ? num(app.retainage_pct) : 10;
  }
  function lineG(l) { return round2(num(l.scheduledValue) * num(l.pctComplete) / 100 + num(l.stored)); }
  function lineThisPeriod(l) { return round2(lineG(l) - num(l.previous)); }

  function computeSummary(app) {
    var lines = (app && Array.isArray(app.lines)) ? app.lines : [];
    var s = { original: 0, co: 0, contract: 0, completedStored: 0, retainage: 0,
              earnedLessRet: 0, lessPrevious: 0, dueThis: 0, balance: 0, thisPeriod: 0, storedTotal: 0 };
    lines.forEach(function (l) {
      var C = num(l.scheduledValue), G = lineG(l), rp = lineRetPct(l, app) / 100;
      if (l.type === 'co') s.co += C; else s.original += C;
      s.completedStored += G;
      s.storedTotal += num(l.stored);
      s.retainage += G * rp;
      s.lessPrevious += num(l.previous) * (1 - rp);
      s.thisPeriod += lineThisPeriod(l);
    });
    s.contract = s.original + s.co;
    s.earnedLessRet = s.completedStored - s.retainage;
    s.dueThis = s.earnedLessRet - s.lessPrevious;
    s.balance = s.contract - s.completedStored;
    return s;
  }

  // ── derive Schedule of Values from the live node graph ────
  function baseName(n, fallback) {
    var s = String((n && n.label) || fallback || '');
    return s.split(' › ')[0].split(' > ')[0].trim() || fallback || '';
  }
  function deriveSOV(jobId) {
    var NG = window.NG;
    if (!NG || typeof NG.nodes !== 'function') return { ok: false, reason: 'engine', lines: [] };
    if (NG.job() !== jobId) return { ok: false, reason: 'notloaded', lines: [] };
    var nodes = NG.nodes() || [], wires = NG.wires() || [];
    var t1s = nodes.filter(function (n) { return n.type === 't1'; });
    var t2s = nodes.filter(function (n) { return n.type === 't2'; });
    var cos = nodes.filter(function (n) { return n.type === 'co'; });
    var lines = [];
    // Phase → building lines (one per allocation with revenue)
    t2s.forEach(function (t2) {
      var placed = false;
      t1s.forEach(function (t1) {
        var rev = 0;
        try { rev = NG.getPhaseRevenueToBuilding(t2, t1.id) || 0; } catch (e) {}
        if (rev > 0.005) {
          placed = true;
          lines.push({ id: 'ln_' + t2.id + '__' + t1.id, nodeId: t2.id, buildingId: t1.id,
            buildingName: baseName(t1, 'Building'), description: baseName(t2, 'Phase'),
            type: 'phase', scheduledValue: round2(rev), pctComplete: round2(num(t2.pctComplete)),
            stored: 0, retainagePct: null, previous: 0 });
        }
      });
      if (!placed) {
        var rev2 = num(t2.revenue);
        if (rev2 > 0.005) {
          lines.push({ id: 'ln_' + t2.id + '__gen', nodeId: t2.id, buildingId: '__gen',
            buildingName: 'General', description: baseName(t2, 'Phase'), type: 'phase',
            scheduledValue: round2(rev2), pctComplete: round2(num(t2.pctComplete)),
            stored: 0, retainagePct: null, previous: 0 });
        }
      }
    });
    // CO → parent lines
    cos.forEach(function (co) {
      var outW = wires.filter(function (w) { return w.fromNode === co.id; });
      var placed = false;
      outW.forEach(function (w) {
        var tgt = nodes.find(function (n) { return n.id === w.toNode; });
        if (tgt && tgt.type === 't1') {
          var inc = 0;
          try { inc = NG.getCOIncomeToParent(co, tgt.id) || 0; } catch (e) {}
          if (inc > 0.005) {
            placed = true;
            lines.push({ id: 'ln_' + co.id + '__' + tgt.id, nodeId: co.id, buildingId: tgt.id,
              buildingName: baseName(tgt, 'Building'), description: 'CO: ' + baseName(co, 'Change Order'),
              type: 'co', scheduledValue: round2(inc), pctComplete: round2(num(co.pctComplete)),
              stored: 0, retainagePct: null, previous: 0 });
          }
        }
      });
      if (!placed) {
        var inc2 = 0;
        try { if (NG.resetComp) NG.resetComp(); inc2 = num(NG.getOutput ? NG.getOutput(co, 0) : 0); } catch (e) {}
        if (inc2 > 0.005) {
          lines.push({ id: 'ln_' + co.id + '__gen', nodeId: co.id, buildingId: '__gen',
            buildingName: 'General', description: 'CO: ' + baseName(co, 'Change Order'), type: 'co',
            scheduledValue: round2(inc2), pctComplete: round2(num(co.pctComplete)),
            stored: 0, retainagePct: null, previous: 0 });
        }
      }
    });
    // Tier 2 — phases carry no revenue (common while the node-graph cost model
    // is still being wired: revenue lives on the job, not distributed to phase
    // nodes). Fall back to buildings that DO carry an allocated/derived budget,
    // one SOV line per building.
    if (!lines.length) {
      t1s.forEach(function (t1) {
        var rev = 0;
        try { rev = NG.getBuildingAllocatedRevenue(t1) || 0; } catch (e) {}
        if (rev <= 0.005) rev = num(t1.revenue);
        if (rev > 0.005) {
          var bp = 0; try { bp = NG.getT1WeightedPct(t1); } catch (e) { bp = num(t1.pctComplete); }
          lines.push({ id: 'ln_bld_' + t1.id, nodeId: t1.id, buildingId: t1.id,
            buildingName: baseName(t1, 'Building'), description: baseName(t1, 'Building'),
            type: 'phase', scheduledValue: round2(rev), pctComplete: round2(num(bp)),
            stored: 0, retainagePct: null, previous: 0 });
        }
      });
    }
    // Tier 3 — nothing in the graph carries revenue yet. Seed a single Base
    // Contract line from the job's contract so there's a billable schedule to
    // start from; the user can split it into scope lines by hand (+ Add line).
    if (!lines.length) {
      var job = (window.appData && appData.jobs) ? appData.jobs.find(function (j) { return j.id === jobId; }) : null;
      var contract = job ? num(job.contractAmount || job.asSoldRevenue || job.contractValue || job.totalIncome || 0) : 0;
      if (contract > 0.005) {
        lines.push({ id: 'ln_base', nodeId: null, buildingId: '__gen', buildingName: 'General',
          description: 'Base Contract', type: 'phase', scheduledValue: round2(contract),
          pctComplete: 0, stored: 0, retainagePct: null, previous: 0, manual: true });
      }
    }
    return { ok: lines.length > 0, reason: lines.length ? '' : 'empty', lines: lines };
  }

  // Re-pull scheduled values from the graph for EXISTING lines (match by
  // nodeId+buildingId), preserving pct/stored/retainage. Adds any brand-new
  // allocations. Used by "↻ Resync from Site Plan".
  function resyncSOV(app) {
    var fresh = deriveSOV(_st.jobId);
    if (!fresh.ok) return fresh;
    var byId = {};
    (app.lines || []).forEach(function (l) { byId[l.id] = l; });
    var merged = fresh.lines.map(function (nl) {
      var old = byId[nl.id];
      if (old) return Object.assign({}, nl, {
        pctComplete: num(old.pctComplete), stored: num(old.stored),
        retainagePct: old.retainagePct, previous: num(old.previous)
      });
      return nl;
    });
    return { ok: true, lines: merged };
  }

  // ── data load ─────────────────────────────────────────────
  function load(jobId) {
    _st.loading = true; _st.error = null;
    if (!window.p86Api || !window.p86Api.payApplications) {
      _st.loading = false; _st.error = 'API unavailable'; paint(); return;
    }
    window.p86Api.payApplications.listForJob(jobId).then(function (r) {
      _st.apps = (r && r.pay_applications) || [];
      _st.apps.sort(function (a, b) { return (b.app_no || 0) - (a.app_no || 0); });
      if (!_st.currentId || !_st.apps.some(function (a) { return a.id === _st.currentId; })) {
        _st.currentId = _st.apps.length ? _st.apps[0].id : null;
      }
      _st.loading = false; paint();
    }).catch(function (e) {
      _st.loading = false; _st.error = (e && e.message) || 'Failed to load'; paint();
    });
  }

  // ── one-time styles (dark-theme inputs) ───────────────────
  function ensureStyles() {
    if (document.getElementById('pa-styles')) return;
    var st = document.createElement('style');
    st.id = 'pa-styles';
    st.textContent =
      '.pa-input{background:var(--input-bg,#0f131a);border:1px solid var(--border,#2a2f3a);border-radius:6px;' +
      'color:var(--text,#fff);font-size:12.5px;padding:5px 8px;font-family:inherit;}' +
      '.pa-input:focus{outline:none;border-color:var(--accent,#4f8cff);}' +
      '.pa-cell:focus{outline:none;border-color:var(--accent,#4f8cff);}' +
      '#job-payapps .ee-btn[disabled],#job-payapps .pa-input[disabled],#job-payapps .pa-cell[disabled]{opacity:.55;cursor:not-allowed;}';
    document.head.appendChild(st);
  }

  // ── entry point ───────────────────────────────────────────
  function renderPayApps(jobId) {
    ensureStyles();
    var host = document.getElementById('job-payapps');
    if (!host) return;
    if (_st.jobId !== jobId) { _st.jobId = jobId; _st.currentId = null; _st.apps = []; }
    host.innerHTML = '<div class="pa-loading" style="padding:28px;text-align:center;color:var(--text-dim,#8b93a7);font-size:13px;">Loading applications for payment…</div>';
    load(jobId);
  }

  // ── render ────────────────────────────────────────────────
  function paint() {
    var host = document.getElementById('job-payapps');
    if (!host) return;
    if (_st.loading) { return; }
    if (_st.error) {
      host.innerHTML = '<div style="padding:24px;color:var(--red,#f87171);font-size:13px;">' + esc(_st.error) + '</div>';
      return;
    }
    var app = currentApp();
    host.innerHTML =
      '<div class="pa-wrap" style="max-width:1180px;margin:0 auto;padding:4px 2px 40px;">' +
        headerHTML(app) +
        billingLedgerHTML() +
        (app ? appBodyHTML(app) : emptyHTML()) +
      '</div>';
    wire(host, app);
  }

  function headerHTML(app) {
    var opts = _st.apps.map(function (a) {
      return '<option value="' + esc(a.id) + '"' + (a.id === _st.currentId ? ' selected' : '') + '>' +
        'Application No. ' + esc(a.app_no) + ' — ' + esc(fmtDate(a.period_to)) + ' (' + esc(a.status) + ')' +
        '</option>';
    }).join('');
    var sel = _st.apps.length
      ? '<select id="pa-app-sel" class="pa-input" style="min-width:250px;">' + opts + '</select>'
      : '';
    var canNew = jobCanEdit();
    return '' +
      '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:14px;">' +
        '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">' +
          '<h2 style="font-size:16px;font-weight:700;margin:0;color:var(--text,#fff);letter-spacing:-.2px;">Application for Payment</h2>' +
          '<span style="font-size:10.5px;color:var(--text-dim,#8b93a7);border:1px solid var(--border,#2a2f3a);padding:2px 7px;border-radius:6px;letter-spacing:.4px;">AIA G702 / G703</span>' +
        '</div>' +
        '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">' +
          sel +
          (canNew ? '<button id="pa-new" class="ee-btn primary" style="font-size:12px;white-space:nowrap;">+ New Application</button>' : '') +
        '</div>' +
      '</div>' +
      (_st.saving ? '<div id="pa-savechip" style="font-size:11px;color:var(--text-dim,#8b93a7);margin-bottom:6px;">Saving…</div>'
        : (_st.dirty ? '<div id="pa-savechip" style="font-size:11px;color:var(--yellow,#fbbf24);margin-bottom:6px;">Unsaved changes</div>'
        : '<div id="pa-savechip" style="font-size:11px;color:var(--green,#34d399);margin-bottom:6px;height:16px;">' + (app ? '&#10003; Saved' : '') + '</div>'));
  }

  function emptyHTML() {
    var canNew = jobCanEdit();
    return '<div style="border:1px dashed var(--border,#2a2f3a);border-radius:12px;padding:40px 24px;text-align:center;">' +
      '<div style="font-size:34px;margin-bottom:10px;">&#x1F9FE;</div>' +
      '<div style="font-size:14px;color:var(--text,#fff);font-weight:600;margin-bottom:6px;">No applications for payment yet</div>' +
      '<div style="font-size:12.5px;color:var(--text-dim,#8b93a7);max-width:440px;margin:0 auto 16px;line-height:1.5;">' +
        'Create the first Application for Payment. The Schedule of Values is built automatically from this job&rsquo;s ' +
        'buildings, phases and change orders on the Site Plan.' +
      '</div>' +
      (canNew ? '<button id="pa-new-empty" class="ee-btn primary" style="font-size:13px;">Create Application No. 1</button>'
        : '<div style="font-size:12px;color:var(--text-dim,#8b93a7);">You don&rsquo;t have permission to create billing applications.</div>') +
    '</div>';
  }

  function appBodyHTML(app) {
    var s = computeSummary(app);
    var editable = appEditable(app);
    return summaryStripHTML(app, s) + metaRowHTML(app, editable) + sovTableHTML(app, s, editable) + actionBarHTML(app, editable);
  }

  // G702 certificate summary — metric tiles. Each value span carries a
  // data-live key so updateLive() can rewrite it without a full repaint.
  function summaryStripHTML(app, s) {
    function tile(label, key, val, opts) {
      opts = opts || {};
      var color = opts.color || 'var(--text,#fff)';
      var big = opts.big;
      return '<div style="flex:1 1 150px;min-width:140px;background:var(--card-bg,#141821);border:1px solid var(--border,#2a2f3a);' +
        (big ? 'border-color:var(--accent,#4f8cff);box-shadow:0 0 0 1px var(--accent,#4f8cff) inset;' : '') +
        'border-radius:10px;padding:10px 12px;">' +
        '<div style="font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:var(--text-dim,#8b93a7);margin-bottom:4px;">' + esc(label) + '</div>' +
        '<div data-live="sum:' + key + '" style="font-family:\'SF Mono\',ui-monospace,monospace;font-size:' + (big ? '17px' : '14px') + ';font-weight:700;color:' + color + ';">' + esc(fmtC(val)) + '</div>' +
      '</div>';
    }
    return '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px;">' +
      tile('Original Contract', 'original', s.original) +
      tile('Net Change (COs)', 'co', s.co, { color: s.co ? 'var(--accent,#4f8cff)' : 'var(--text,#fff)' }) +
      tile('Contract Sum to Date', 'contract', s.contract) +
      tile('Completed & Stored', 'completedStored', s.completedStored) +
      tile('Retainage', 'retainage', s.retainage, { color: 'var(--yellow,#fbbf24)' }) +
      tile('Less Previous', 'lessPrevious', s.lessPrevious) +
      tile('Current Payment Due', 'dueThis', s.dueThis, { big: true, color: 'var(--green,#34d399)' }) +
      tile('Balance to Finish', 'balance', s.balance, { color: 'var(--text-dim,#c3c9d6)' }) +
    '</div>';
  }

  function metaRowHTML(app, editable) {
    var dis = editable ? '' : ' disabled';
    return '<div style="display:flex;gap:14px;flex-wrap:wrap;align-items:flex-end;margin-bottom:12px;padding:10px 12px;background:var(--card-bg,#141821);border:1px solid var(--border,#2a2f3a);border-radius:10px;">' +
      field('Application No.', '<div style="font-family:\'SF Mono\',monospace;font-size:14px;font-weight:700;color:var(--text,#fff);">' + esc(app.app_no) + '</div>') +
      field('Period To', '<input type="date" id="pa-period" class="pa-input"' + dis + ' value="' + esc((app.period_to || '').slice(0, 10)) + '">') +
      field('Retainage %', '<input type="number" id="pa-retpct" class="pa-input" style="width:80px;"' + dis + ' min="0" max="100" step="0.5" value="' + esc(app.retainage_pct) + '">') +
      field('Status', statusBadge(app.status)) +
      '<div style="flex:1 1 180px;">' +
        '<div style="font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:var(--text-dim,#8b93a7);margin-bottom:3px;">Notes</div>' +
        '<input type="text" id="pa-notes" class="pa-input" style="width:100%;"' + dis + ' placeholder="Optional note for this draw" value="' + esc(app.notes || '') + '">' +
      '</div>' +
    '</div>';
  }
  function field(label, inner) {
    return '<div><div style="font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:var(--text-dim,#8b93a7);margin-bottom:3px;">' + esc(label) + '</div>' + inner + '</div>';
  }
  function statusBadge(status) {
    status = String(status || 'draft');
    var map = {
      draft: ['#cbd5e1', 'rgba(148,163,184,.14)'],
      submitted: ['var(--accent,#4f8cff)', 'rgba(79,140,255,.14)'],
      certified: ['var(--green,#34d399)', 'rgba(52,211,153,.14)'],
      paid: ['#a78bfa', 'rgba(167,139,250,.16)']
    };
    var c = map[status] || map.draft;
    return '<span style="display:inline-block;padding:3px 10px;border-radius:10px;font-size:10.5px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;color:' + c[0] + ';background:' + c[1] + ';">' + esc(status) + '</span>';
  }

  // G703 continuation sheet — SOV lines grouped by building.
  function sovTableHTML(app, s, editable) {
    var lines = Array.isArray(app.lines) ? app.lines : [];
    if (!lines.length) {
      return '<div style="border:1px dashed var(--border,#2a2f3a);border-radius:10px;padding:26px;text-align:center;color:var(--text-dim,#8b93a7);font-size:12.5px;margin-bottom:14px;">' +
        '<div style="margin-bottom:12px;">No schedule-of-values lines yet. Build the schedule by hand, or add buildings / phases / change orders on the Site Plan and use &ldquo;&#8635; Resync from Site Plan&rdquo;.</div>' +
        (editable ? '<button id="pa-addline" class="ee-btn primary" style="font-size:12px;">+ Add line</button>' : '') +
      '</div>';
    }
    // group by building, preserving first-seen order
    var groups = [], gmap = {};
    lines.forEach(function (l) {
      var k = l.buildingId || '__gen';
      if (!gmap[k]) { gmap[k] = { key: k, name: l.buildingName || 'General', rows: [] }; groups.push(gmap[k]); }
      gmap[k].rows.push(l);
    });
    var dis = editable ? '' : ' disabled';
    var multi = groups.length > 1;
    var head =
      '<thead><tr style="background:var(--overlay-light,rgba(255,255,255,.03));border-bottom:1px solid var(--border,#2a2f3a);">' +
        th('#', 'left') + th('Description of Work', 'left') + th('Scheduled Value', 'right') +
        th('Previous', 'right') + th('% Compl.', 'right') + th('This Period', 'right') +
        th('Stored', 'right') + th('Compl. + Stored', 'right') + th('%', 'right') +
        th('Balance', 'right') + th('Ret %', 'right') + th('Retainage', 'right') + th('', 'right') +
      '</tr></thead>';
    var bodyRows = '';
    var idx = 0;
    groups.forEach(function (g) {
      var gt = { C: 0, prev: 0, G: 0, ret: 0, tp: 0, stored: 0 };
      var rows = g.rows.map(function (l) {
        idx++;
        var C = num(l.scheduledValue), G = lineG(l), tp = lineThisPeriod(l), rp = lineRetPct(l, app),
            ret = round2(G * rp / 100), bal = round2(C - G), pctG = C ? (G / C * 100) : 0;
        gt.C += C; gt.prev += num(l.previous); gt.G += G; gt.ret += ret; gt.tp += tp; gt.stored += num(l.stored);
        var coBadge = (l.type === 'co') ? ' <span style="font-size:9px;color:var(--accent,#4f8cff);border:1px solid var(--accent,#4f8cff);border-radius:4px;padding:0 3px;">CO</span>' : '';
        var descCell = editable
          ? '<td style="padding:4px 8px;vertical-align:middle;"><input type="text" class="pa-desc pa-cell" data-lid="' + esc(l.id) + '" value="' + esc(l.description) + '" placeholder="Description" style="width:190px;background:var(--input-bg,#0f131a);border:1px solid var(--border,#2a2f3a);border-radius:5px;color:var(--text,#fff);font-size:12px;padding:4px 6px;">' + coBadge + '</td>'
          : tdL('<span style="color:var(--text,#fff);font-size:12.5px;">' + esc(l.description) + coBadge + '</span>');
        var schedCell = editable
          ? '<td class="num" style="padding:4px 8px;text-align:right;vertical-align:middle;"><input type="number" class="pa-sched pa-cell" data-lid="' + esc(l.id) + '" value="' + esc(C) + '" step="0.01" min="0" style="width:104px;text-align:right;background:var(--input-bg,#0f131a);border:1px solid var(--border,#2a2f3a);border-radius:5px;color:var(--text,#fff);font-family:\'SF Mono\',monospace;font-size:12px;padding:3px 5px;"></td>'
          : tdN(fmtC(C));
        var delCell = editable
          ? '<td style="text-align:center;vertical-align:middle;padding:4px 6px;"><button class="pa-del" data-lid="' + esc(l.id) + '" title="Remove line" style="background:none;border:none;color:var(--text-dim,#8b93a7);cursor:pointer;font-size:16px;line-height:1;">&times;</button></td>'
          : '<td></td>';
        return '<tr data-lid="' + esc(l.id) + '" style="border-bottom:1px solid var(--overlay-light,rgba(255,255,255,.04));">' +
          tdL('<span style="color:var(--text-dim,#8b93a7);font-size:11px;">' + idx + '</span>') +
          descCell + schedCell +
          tdN(live('ln-prev:' + l.id, fmtC(l.previous), 'var(--text-dim,#8b93a7)')) +
          tdInput('pa-pct', l.id, l.pctComplete, dis, '%') +
          tdN(live('ln-tp:' + l.id, fmtC(tp), tpColor(tp), true)) +
          tdInput('pa-stored', l.id, l.stored, dis, '$') +
          tdN(live('ln-g:' + l.id, fmtC(G), 'var(--text,#fff)', true)) +
          tdN(live('ln-pctg:' + l.id, fmtPct(pctG), 'var(--text-dim,#8b93a7)')) +
          tdN(live('ln-bal:' + l.id, fmtC(bal), 'var(--text-dim,#8b93a7)')) +
          tdInput('pa-ret', l.id, (l.retainagePct == null || l.retainagePct === '') ? '' : l.retainagePct, dis, 'r', num(app.retainage_pct)) +
          tdN(live('ln-ret:' + l.id, fmtC(ret), 'var(--yellow,#fbbf24)')) +
          delCell +
        '</tr>';
      }).join('');
      var groupHdr = '<tr style="background:var(--overlay,rgba(255,255,255,.05));"><td colspan="13" style="padding:6px 10px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--accent-2,#7dd3fc);">' + esc(g.name) + '</td></tr>';
      var pctGt = gt.C ? (gt.G / gt.C * 100) : 0, k = g.key;
      var subtotal = '<tr style="background:var(--overlay-light,rgba(255,255,255,.02));border-top:1px solid var(--border,#2a2f3a);border-bottom:1px solid var(--border,#2a2f3a);">' +
        tdL('') + tdL('<span style="font-size:11px;color:var(--text-dim,#8b93a7);font-weight:600;">Subtotal &mdash; ' + esc(g.name) + '</span>') +
        tdN(live('gt-C:' + k, fmtC(gt.C), 'var(--text,#fff)', true)) + tdN(live('gt-prev:' + k, fmtC(gt.prev), 'var(--text-dim,#8b93a7)')) +
        tdN('') + tdN(live('gt-tp:' + k, fmtC(gt.tp), 'var(--text,#fff)')) + tdN(live('gt-stored:' + k, fmtC(gt.stored), 'var(--text-dim,#8b93a7)')) +
        tdN(live('gt-g:' + k, fmtC(gt.G), 'var(--text,#fff)')) + tdN(live('gt-pctg:' + k, fmtPct(pctGt), 'var(--text-dim,#8b93a7)')) +
        tdN(live('gt-bal:' + k, fmtC(gt.C - gt.G), 'var(--text-dim,#8b93a7)')) + tdN('') +
        tdN(live('gt-ret:' + k, fmtC(gt.ret), 'var(--yellow,#fbbf24)')) + tdN('') +
      '</tr>';
      bodyRows += groupHdr + rows + (multi ? subtotal : '');
    });
    var pctGrand = s.contract ? (s.completedStored / s.contract * 100) : 0;
    var grand = '<tr style="background:var(--overlay,rgba(255,255,255,.06));border-top:2px solid var(--border,#3a4150);">' +
      tdL('') + tdL('<span style="font-size:12px;color:var(--text,#fff);font-weight:800;letter-spacing:.3px;">GRAND TOTAL</span>') +
      tdN(live('grand-contract', fmtC(s.contract), 'var(--text,#fff)', true)) +
      tdN(live('grand-prev', fmtC(sumField(app, 'previous')), 'var(--text-dim,#8b93a7)')) +
      tdN('') + tdN(live('grand-tp', fmtC(s.thisPeriod), 'var(--green,#34d399)')) +
      tdN(live('grand-stored', fmtC(s.storedTotal), 'var(--text-dim,#8b93a7)')) +
      tdN(live('grand-g', fmtC(s.completedStored), 'var(--text,#fff)')) +
      tdN(live('grand-pctg', fmtPct(pctGrand), 'var(--text-dim,#8b93a7)')) +
      tdN(live('grand-bal', fmtC(s.balance), 'var(--text-dim,#8b93a7)')) + tdN('') +
      tdN(live('grand-ret', fmtC(s.retainage), 'var(--yellow,#fbbf24)')) + tdN('') +
    '</tr>';
    var addRow = editable
      ? '<tr><td colspan="13" style="padding:8px 10px;"><button id="pa-addline" class="ee-btn" style="font-size:12px;">+ Add line</button></td></tr>'
      : '';
    return '<div style="border:1px solid var(--border,#2a2f3a);border-radius:10px;overflow-x:auto;background:var(--card-bg,#141821);margin-bottom:14px;">' +
      '<table style="width:100%;border-collapse:collapse;min-width:1080px;">' + head + '<tbody>' + bodyRows + grand + addRow + '</tbody></table>' +
    '</div>';
  }
  function sumField(app, f) {
    return (app.lines || []).reduce(function (a, l) { return a + num(l[f]); }, 0);
  }
  function th(label, align) {
    return '<th style="text-align:' + align + ';padding:8px 10px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:var(--text-dim,#8b93a7);white-space:nowrap;">' + esc(label) + '</th>';
  }
  function tdL(inner) { return '<td style="padding:7px 10px;font-size:12.5px;vertical-align:middle;">' + inner + '</td>'; }
  function tdN(inner) { return '<td class="num" style="padding:7px 10px;text-align:right;white-space:nowrap;font-family:\'SF Mono\',ui-monospace,monospace;font-size:12.5px;vertical-align:middle;">' + inner + '</td>'; }
  // A live-updatable value span. updateLive() rewrites its text + color in place.
  function live(key, text, color, bold) {
    return '<span data-live="' + esc(key) + '" style="color:' + color + ';' + (bold ? 'font-weight:700;' : '') + '">' + esc(text) + '</span>';
  }
  function tpColor(tp) { return tp > 0.005 ? 'var(--green,#34d399)' : (tp < -0.005 ? 'var(--red,#f87171)' : 'var(--text-dim,#8b93a7)'); }
  // Editable numeric cell. kind: '%' pctComplete · '$' stored · 'r' per-line retainage (placeholder = app default)
  function tdInput(cls, lid, val, dis, kind, placeholder) {
    var w = kind === '$' ? '86px' : '62px';
    var ph = kind === 'r' ? ' placeholder="' + esc(placeholder) + '"' : '';
    var suffix = kind === '%' ? '%' : (kind === 'r' ? '%' : '');
    var shown = (val === '' || val == null) ? '' : val;
    return '<td class="num" style="padding:4px 8px;text-align:right;white-space:nowrap;vertical-align:middle;">' +
      '<span style="display:inline-flex;align-items:center;gap:2px;">' +
        '<input type="number" class="' + cls + ' pa-cell" data-lid="' + esc(lid) + '"' + dis + ph +
          ' value="' + esc(shown) + '" step="' + (kind === '$' ? '0.01' : '1') + '" min="0"' + (kind === '%' ? ' max="100"' : '') +
          ' style="width:' + w + ';text-align:right;background:var(--input-bg,#0f131a);border:1px solid var(--border,#2a2f3a);border-radius:5px;color:var(--text,#fff);font-family:\'SF Mono\',monospace;font-size:12px;padding:3px 5px;">' +
        (suffix ? '<span style="font-size:10px;color:var(--text-dim,#8b93a7);">' + suffix + '</span>' : '') +
      '</span>' +
    '</td>';
  }

  function actionBarHTML(app, editable) {
    var btns = [];
    // status transitions
    if (app.status === 'draft') btns.push(pbtn('pa-submit', 'Submit', 'primary'));
    if (app.status === 'submitted') { btns.push(pbtn('pa-certify', 'Certify', 'primary')); btns.push(pbtn('pa-unsubmit', '&larr; Back to Draft', '')); }
    if (app.status === 'certified') { btns.push(pbtn('pa-paid', 'Mark Paid', 'primary')); btns.push(pbtn('pa-uncertify', '&larr; Back to Submitted', '')); }
    if (app.status === 'paid') btns.push(pbtn('pa-unpaid', '&larr; Reopen (uncertify-pay)', ''));
    var left = '<div style="display:flex;gap:8px;flex-wrap:wrap;">' + btns.join('') + '</div>';
    var right = '<div style="display:flex;gap:8px;flex-wrap:wrap;">' +
      (editable ? '<button id="pa-pullpct" class="ee-btn" style="font-size:12px;" title="Set each line\'s % complete from Site Plan unit/phase progress">&#8635; % from progress</button>' : '') +
      (editable ? '<button id="pa-resync" class="ee-btn" style="font-size:12px;" title="Re-pull scheduled values from the Site Plan (keeps your % and stored)">&#8635; Resync values</button>' : '') +
      '<button id="pa-export-pdf" class="ee-btn" style="font-size:12px;" title="Print / Save the G702 + G703 as a PDF">&#x2913; PDF</button>' +
      '<button id="pa-export-xlsx" class="ee-btn" style="font-size:12px;" title="Download the schedule of values as Excel">&#x2913; Excel</button>' +
      ((app.status === 'draft' && jobCanEdit()) ? '<button id="pa-delete" class="ee-btn" style="font-size:12px;color:var(--red,#f87171);border-color:var(--red,#f87171);">Delete</button>' : '') +
    '</div>';
    return '<div style="display:flex;gap:12px;justify-content:space-between;flex-wrap:wrap;align-items:center;">' + left + right + '</div>';
  }
  function pbtn(id, label, cls) {
    return '<button id="' + id + '" class="ee-btn ' + (cls || '') + '" style="font-size:12px;">' + label + '</button>';
  }

  // ── event wiring ──────────────────────────────────────────
  function wire(host, app) {
    var sel = host.querySelector('#pa-app-sel');
    if (sel) sel.addEventListener('change', function () {
      if (_st.dirty) { flushSave(); }
      _st.currentId = sel.value; _st.dirty = false; paint();
    });
    ['#pa-new', '#pa-new-empty'].forEach(function (q) {
      var b = host.querySelector(q); if (b) b.addEventListener('click', createApp);
    });
    if (!app) return;

    // meta inputs → in-memory + debounced save
    bindMeta(host, 'pa-period', 'period_to', app);
    bindMeta(host, 'pa-retpct', 'retainage_pct', app);
    bindMeta(host, 'pa-notes', 'notes', app);

    // line cells → recompute live + debounced save (input drives everything;
    // change/blur is a redundant safety net that coalesces via the debounce)
    host.querySelectorAll('.pa-cell').forEach(function (inp) {
      inp.addEventListener('input', function () { onCell(inp, app); });
      inp.addEventListener('change', function () { onCell(inp, app); });
    });
    // manual schedule-of-values editing: add + remove lines
    bindClick(host, '#pa-addline', function () { addLine(app); });
    host.querySelectorAll('.pa-del').forEach(function (b) {
      b.addEventListener('click', function () { removeLine(app, b.getAttribute('data-lid')); });
    });

    bindClick(host, '#pa-pullpct', function () { pullProgress(app); });
    bindClick(host, '#pa-resync', function () { doResync(app); });
    bindClick(host, '#pa-export-pdf', function () { exportPDF(app); });
    bindClick(host, '#pa-export-xlsx', function () { exportXLSX(app); });
    bindClick(host, '#pa-delete', function () { delApp(app); });
    bindClick(host, '#pa-submit', function () { setStatus(app, 'submitted'); });
    bindClick(host, '#pa-unsubmit', function () { setStatus(app, 'draft'); });
    bindClick(host, '#pa-certify', function () { confirmCertify(app); });
    bindClick(host, '#pa-uncertify', function () { setStatus(app, 'submitted'); });
    bindClick(host, '#pa-paid', function () { setStatus(app, 'paid'); });
    bindClick(host, '#pa-unpaid', function () { setStatus(app, 'certified'); });
  }
  function bindClick(host, q, fn) { var b = host.querySelector(q); if (b) b.addEventListener('click', fn); }
  function bindMeta(host, id, field, app) {
    var el = host.querySelector('#' + id); if (!el) return;
    el.addEventListener('change', function () {
      app[field] = (field === 'retainage_pct') ? num(el.value) : el.value;
      _st.dirty = true;
      if (field === 'retainage_pct') { updateLive(); }
      scheduleSave();
      updateSaveChip();
    });
  }

  // A line cell changed → update memory, recompute derived cells surgically
  // (never touching the input the user is in), schedule a save.
  function onCell(inp, app) {
    var lid = inp.getAttribute('data-lid');
    var line = (app.lines || []).find(function (l) { return l.id === lid; });
    if (!line) return;
    if (inp.classList.contains('pa-pct')) line.pctComplete = clamp(num(inp.value), 0, 100);
    else if (inp.classList.contains('pa-stored')) line.stored = Math.max(0, num(inp.value));
    else if (inp.classList.contains('pa-ret')) line.retainagePct = (String(inp.value).trim() === '') ? null : clamp(num(inp.value), 0, 100);
    else if (inp.classList.contains('pa-sched')) { line.scheduledValue = Math.max(0, num(inp.value)); line.manual = true; }
    else if (inp.classList.contains('pa-desc')) { line.description = inp.value; line.manual = true; }
    _st.dirty = true;
    updateLive();
    updateSaveChip();
    scheduleSave();
  }
  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

  // Recompute every read-only derived cell + the G702 strip from _st and write
  // the new values into their [data-live] spans in place. No DOM teardown, so
  // the input being typed in keeps focus + caret.
  function updateLive() {
    var host = document.getElementById('job-payapps'); if (!host) return;
    var app = currentApp(); if (!app) return;
    var s = computeSummary(app);
    function set(key, text, color) {
      var el = host.querySelector('[data-live="' + key.replace(/"/g, '') + '"]');
      if (!el) return;
      el.textContent = text;
      if (color) el.style.color = color;
    }
    // G702 summary tiles
    set('sum:original', fmtC(s.original)); set('sum:co', fmtC(s.co), s.co ? 'var(--accent,#4f8cff)' : 'var(--text,#fff)');
    set('sum:contract', fmtC(s.contract)); set('sum:completedStored', fmtC(s.completedStored));
    set('sum:retainage', fmtC(s.retainage)); set('sum:lessPrevious', fmtC(s.lessPrevious));
    set('sum:dueThis', fmtC(s.dueThis)); set('sum:balance', fmtC(s.balance));
    // per-line + group subtotals
    var groups = {}, order = [];
    (app.lines || []).forEach(function (l) {
      var C = num(l.scheduledValue), G = lineG(l), tp = lineThisPeriod(l), rp = lineRetPct(l, app),
          ret = round2(G * rp / 100), bal = round2(C - G), pctG = C ? (G / C * 100) : 0;
      set('ln-tp:' + l.id, fmtC(tp), tpColor(tp));
      set('ln-g:' + l.id, fmtC(G)); set('ln-pctg:' + l.id, fmtPct(pctG));
      set('ln-bal:' + l.id, fmtC(bal)); set('ln-ret:' + l.id, fmtC(ret));
      var k = l.buildingId || '__gen';
      if (!groups[k]) { groups[k] = { C: 0, prev: 0, G: 0, ret: 0, tp: 0, stored: 0 }; order.push(k); }
      var gt = groups[k];
      gt.C += C; gt.prev += num(l.previous); gt.G += G; gt.ret += ret; gt.tp += tp; gt.stored += num(l.stored);
    });
    order.forEach(function (k) {
      var gt = groups[k], pctGt = gt.C ? (gt.G / gt.C * 100) : 0;
      set('gt-C:' + k, fmtC(gt.C)); set('gt-tp:' + k, fmtC(gt.tp)); set('gt-stored:' + k, fmtC(gt.stored));
      set('gt-g:' + k, fmtC(gt.G)); set('gt-pctg:' + k, fmtPct(pctGt));
      set('gt-bal:' + k, fmtC(gt.C - gt.G)); set('gt-ret:' + k, fmtC(gt.ret));
    });
    // grand total
    var pctGrand = s.contract ? (s.completedStored / s.contract * 100) : 0;
    set('grand-contract', fmtC(s.contract));
    set('grand-tp', fmtC(s.thisPeriod)); set('grand-stored', fmtC(s.storedTotal));
    set('grand-g', fmtC(s.completedStored)); set('grand-pctg', fmtPct(pctGrand));
    set('grand-bal', fmtC(s.balance)); set('grand-ret', fmtC(s.retainage));
  }

  function updateSaveChip() {
    var chip = document.getElementById('pa-savechip'); if (!chip) return;
    if (_st.saving) { chip.textContent = 'Saving…'; chip.style.color = 'var(--text-dim,#8b93a7)'; }
    else if (_st.dirty) { chip.textContent = 'Unsaved changes'; chip.style.color = 'var(--yellow,#fbbf24)'; }
    else { chip.innerHTML = '&#10003; Saved'; chip.style.color = 'var(--green,#34d399)'; }
  }

  // ── persistence ───────────────────────────────────────────
  function scheduleSave() {
    if (_saveTimer) clearTimeout(_saveTimer);
    _saveTimer = setTimeout(flushSave, 700);
  }
  function flushSave() {
    if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
    var app = currentApp();
    if (!app || !_st.dirty || _st.saving) return;
    if (!appEditable(app)) { _st.dirty = false; updateSaveChip(); return; }
    _st.saving = true; updateSaveChip();
    var payload = {
      period_to: app.period_to || null,
      retainage_pct: num(app.retainage_pct),
      notes: app.notes || '',
      lines: app.lines || []
    };
    window.p86Api.payApplications.update(app.id, payload).then(function (r) {
      _st.saving = false; _st.dirty = false;
      if (r && r.pay_application) mergeApp(r.pay_application);
      updateSaveChip();
    }).catch(function (e) {
      _st.saving = false;
      updateSaveChip();
      toast('Save failed: ' + ((e && e.message) || 'error'), true);
    });
  }
  function mergeApp(fresh) {
    var i = _st.apps.findIndex(function (a) { return a.id === fresh.id; });
    if (i >= 0) _st.apps[i] = fresh; else _st.apps.push(fresh);
  }

  function createApp() {
    if (!jobCanEdit()) { toast('You don’t have permission to create billing applications.', true); return; }
    if (_st.dirty) flushSave();
    // Best-effort seed of the schedule of values from the node graph (phases →
    // buildings → job contract). If nothing derives, the app is created with an
    // empty schedule the user builds by hand with "+ Add line".
    var sov = deriveSOV(_st.jobId);
    var prevApp = _st.apps[0]; // highest app_no (sorted desc)
    var payload = {
      period_to: todayISO(),
      retainage_pct: prevApp ? num(prevApp.retainage_pct) : 10,
      notes: '',
      lines: (sov && sov.lines) || []
    };
    _st.saving = true; paint();
    window.p86Api.payApplications.create(_st.jobId, payload).then(function (r) {
      _st.saving = false;
      if (r && r.pay_application) {
        mergeApp(r.pay_application);
        _st.apps.sort(function (a, b) { return (b.app_no || 0) - (a.app_no || 0); });
        _st.currentId = r.pay_application.id;
        _st.dirty = false;
      }
      paint();
      toast('Application No. ' + (r && r.pay_application ? r.pay_application.app_no : '') + ' created.');
    }).catch(function (e) {
      _st.saving = false; paint();
      toast('Create failed: ' + ((e && e.message) || 'error'), true);
    });
  }

  function doResync(app) {
    var r = resyncSOV(app);
    if (!r.ok) { toast('Open the Site Plan first to resync the schedule of values.', true); return; }
    // keep any hand-added (manual) lines the graph doesn't know about
    var manual = (app.lines || []).filter(function (l) { return l.manual && String(l.id).indexOf('ln_m_') === 0; });
    app.lines = r.lines.concat(manual);
    _st.dirty = true;
    paint();
    scheduleSave();
    toast('Scheduled values resynced from the Site Plan.');
  }

  // S5 — pull each graph-linked line's % complete from the Site Plan's live
  // progress (unit/level check-off drives building %, phase-weighted % for
  // phases). Manual (hand-added) lines are left alone.
  function pullProgress(app) {
    if (!appEditable(app)) return;
    var NG = window.NG;
    if (!NG || typeof NG.nodes !== 'function' || NG.job() !== _st.jobId) {
      toast('Open the Site Plan for this job to pull progress.', true); return;
    }
    var nodes = NG.nodes() || [], changed = 0;
    (app.lines || []).forEach(function (l) {
      if (!l.nodeId) return; // manual line — skip
      var node = nodes.find(function (n) { return n.id === l.nodeId; });
      if (!node) return;
      var pct = null;
      try {
        if (node.type === 't1') pct = NG.getT1WeightedPct(node);
        else if (node.type === 't2') pct = NG.getT2WeightedPct(node);
        else pct = node.pctComplete;
      } catch (e) {}
      if (pct != null && isFinite(pct)) { l.pctComplete = clamp(round2(pct), 0, 100); changed++; }
    });
    if (!changed) { toast('No Site-Plan-linked lines to update.'); return; }
    _st.dirty = true; paint(); scheduleSave();
    toast('Pulled % complete from Site Plan progress (' + changed + ' line' + (changed > 1 ? 's' : '') + ').');
  }

  // S4 — billing-to-date ledger, derived from CERTIFIED + PAID applications
  // (the officially-billed draws). Cumulative figures come from the highest-
  // numbered certified/paid app (each app carries the running schedule).
  function billingLedger() {
    var certs = _st.apps.filter(function (a) { return a.status === 'certified' || a.status === 'paid'; });
    if (!certs.length) return null;
    certs.sort(function (a, b) { return (b.app_no || 0) - (a.app_no || 0); });
    var s = computeSummary(certs[0]);
    var paid = _st.apps.filter(function (a) { return a.status === 'paid'; });
    paid.sort(function (a, b) { return (b.app_no || 0) - (a.app_no || 0); });
    var paidToDate = paid.length ? computeSummary(paid[0]).earnedLessRet : 0;
    return { contract: s.contract, completedStored: s.completedStored, retainage: s.retainage,
             billedNet: s.earnedLessRet, remaining: round2(s.contract - s.completedStored),
             paidToDate: paidToDate, outstanding: round2(s.earnedLessRet - paidToDate), latestNo: certs[0].app_no };
  }
  function billingLedgerHTML() {
    var b = billingLedger();
    if (!b) return '';
    function cell(label, val, color) {
      return '<div style="flex:1 1 130px;min-width:120px;"><div style="font-size:9.5px;text-transform:uppercase;letter-spacing:.5px;color:var(--text-dim,#8b93a7);margin-bottom:2px;">' + esc(label) + '</div>' +
        '<div style="font-family:\'SF Mono\',monospace;font-size:13px;font-weight:700;color:' + (color || 'var(--text,#fff)') + ';">' + esc(fmtC(val)) + '</div></div>';
    }
    return '<div style="display:flex;gap:14px;flex-wrap:wrap;align-items:center;padding:10px 14px;margin-bottom:12px;background:linear-gradient(90deg,rgba(52,211,153,.06),transparent);border:1px solid var(--border,#2a2f3a);border-left:3px solid var(--green,#34d399);border-radius:10px;">' +
      '<div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--green,#34d399);flex:0 0 auto;">Billed to Date<br><span style="font-weight:400;color:var(--text-dim,#8b93a7);">thru App ' + esc(b.latestNo) + '</span></div>' +
      cell('Contract Sum', b.contract) +
      cell('Completed & Stored', b.completedStored) +
      cell('Retainage Held', b.retainage, 'var(--yellow,#fbbf24)') +
      cell('Billed (net of ret.)', b.billedNet, 'var(--green,#34d399)') +
      cell('Paid to Date', b.paidToDate) +
      cell('Outstanding', b.outstanding, b.outstanding > 0.005 ? 'var(--accent,#4f8cff)' : 'var(--text-dim,#8b93a7)') +
      cell('Remaining to Bill', b.remaining, 'var(--text-dim,#c3c9d6)') +
    '</div>';
  }

  // Manual schedule-of-values editing — build the SOV by hand when the node
  // graph doesn't carry per-scope revenue (or to split a Base Contract line).
  function addLine(app) {
    if (!appEditable(app)) return;
    app.lines = app.lines || [];
    var id = 'ln_m_' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
    app.lines.push({ id: id, nodeId: null, buildingId: '__gen', buildingName: 'General',
      description: '', type: 'phase', scheduledValue: 0, pctComplete: 0, stored: 0,
      retainagePct: null, previous: 0, manual: true });
    _st.dirty = true;
    paint();
    scheduleSave();
    var host = document.getElementById('job-payapps');
    var inp = host && host.querySelector('.pa-desc[data-lid="' + id + '"]');
    if (inp) inp.focus();
  }
  function removeLine(app, lid) {
    if (!appEditable(app)) return;
    app.lines = (app.lines || []).filter(function (l) { return l.id !== lid; });
    _st.dirty = true;
    paint();
    scheduleSave();
  }

  function setStatus(app, next) {
    if (_st.dirty) flushSave();
    window.p86Api.payApplications.setStatus(app.id, next).then(function (r) {
      if (r && r.pay_application) mergeApp(r.pay_application);
      paint();
      toast('Status → ' + next + '.');
    }).catch(function (e) {
      toast('Could not change status: ' + ((e && e.message) || 'error'), true);
    });
  }
  function confirmCertify(app) {
    var s = computeSummary(app);
    var msg = 'Certify Application No. ' + app.app_no + ' for payment of ' + fmtC(s.dueThis) +
      '? Once certified the schedule of values is locked.';
    doConfirm('Certify Application', msg, function () { setStatus(app, 'certified'); });
  }
  function delApp(app) {
    doConfirm('Delete Application', 'Delete Application No. ' + app.app_no + '? This cannot be undone.', function () {
      window.p86Api.payApplications.remove(app.id).then(function () {
        _st.apps = _st.apps.filter(function (a) { return a.id !== app.id; });
        _st.currentId = _st.apps.length ? _st.apps[0].id : null;
        _st.dirty = false;
        paint();
        toast('Application deleted.');
      }).catch(function (e) { toast('Delete failed: ' + ((e && e.message) || 'error'), true); });
    });
  }

  // ── G702/G703 export (PDF via print window · Excel via SheetJS) ──
  // Header fields for the document (contractor / project / owner).
  function docContext() {
    var job = (window.appData && appData.jobs) ? appData.jobs.find(function (j) { return j.id === _st.jobId; }) : null;
    job = job || {};
    var contractor = '';
    try {
      contractor = (window.appData && (appData.organizationName || (appData.organization && appData.organization.name))) ||
                   (window.p86Branding && window.p86Branding.name) || '';
    } catch (e) {}
    if (!contractor) contractor = 'AG Exteriors';
    var addr = job.address || [job.street, job.city, job.state, job.zip].filter(Boolean).join(', ');
    return {
      contractor: contractor,
      project: (job.jobNumber ? job.jobNumber + ' — ' : '') + (job.title || job.name || 'Project'),
      jobNumber: job.jobNumber || '',
      address: addr || '',
      owner: job.clientName || job.client || job.ownerName || '',
      logo: location.origin + '/images/logo-color.png'
    };
  }
  // Per-line G703 columns (D+E = G; F is a memo breakdown of stored inside G).
  function g703Row(l, app) {
    var C = num(l.scheduledValue), D = num(l.previous), G = lineG(l);
    return { C: C, D: D, E: round2(G - D), F: num(l.stored), G: G,
             pctG: C ? (G / C * 100) : 0, bal: round2(C - G), I: round2(G * lineRetPct(l, app) / 100) };
  }

  function exportPDF(app) {
    var s = computeSummary(app), ctx = docContext();
    var lines = Array.isArray(app.lines) ? app.lines : [];
    var idx = 0, rows = '', tot = { C: 0, D: 0, E: 0, F: 0, G: 0, I: 0, bal: 0 };
    lines.forEach(function (l) {
      idx++;
      var r = g703Row(l, app);
      tot.C += r.C; tot.D += r.D; tot.E += r.E; tot.F += r.F; tot.G += r.G; tot.I += r.I; tot.bal += r.bal;
      rows += '<tr>' +
        '<td class="c">' + idx + '</td>' +
        '<td>' + esc(l.description || '') + (l.type === 'co' ? ' <em>(CO)</em>' : '') + '</td>' +
        '<td class="n">' + fmtC(r.C) + '</td><td class="n">' + fmtC(r.D) + '</td><td class="n">' + fmtC(r.E) + '</td>' +
        '<td class="n">' + fmtC(r.F) + '</td><td class="n b">' + fmtC(r.G) + '</td><td class="c">' + fmtPct(r.pctG) + '</td>' +
        '<td class="n">' + fmtC(r.bal) + '</td><td class="n">' + fmtC(r.I) + '</td>' +
      '</tr>';
    });
    var pctTot = tot.C ? (tot.G / tot.C * 100) : 0;
    var totalRow = '<tr class="tot"><td></td><td>GRAND TOTAL</td>' +
      '<td class="n">' + fmtC(tot.C) + '</td><td class="n">' + fmtC(tot.D) + '</td><td class="n">' + fmtC(tot.E) + '</td>' +
      '<td class="n">' + fmtC(tot.F) + '</td><td class="n b">' + fmtC(tot.G) + '</td><td class="c">' + fmtPct(pctTot) + '</td>' +
      '<td class="n">' + fmtC(tot.bal) + '</td><td class="n">' + fmtC(tot.I) + '</td></tr>';
    var bal9 = round2(s.contract - s.earnedLessRet);
    function g702line(no, label, val, strong) {
      return '<tr' + (strong ? ' class="hi"' : '') + '><td class="ln">' + no + '</td><td>' + label + '</td><td class="n">' + fmtC(val) + '</td></tr>';
    }
    var doc =
      '<!doctype html><html><head><meta charset="utf-8"><title>Application for Payment No. ' + esc(app.app_no) + ' — ' + esc(ctx.project) + '</title><style>' +
      '*{box-sizing:border-box;} body{font-family:Arial,Helvetica,sans-serif;color:#111;margin:0;padding:26px;font-size:12px;}' +
      '.page{max-width:1000px;margin:0 auto 26px;} .page+.page{page-break-before:always;}' +
      '.hd{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #1B3A5C;padding-bottom:10px;margin-bottom:12px;}' +
      '.hd img{height:44px;} .hd .t{text-align:right;} .doctitle{font-size:19px;font-weight:bold;color:#1B3A5C;} .docsub{font-size:11px;color:#666;letter-spacing:.5px;}' +
      '.meta{display:flex;flex-wrap:wrap;gap:6px 28px;font-size:11.5px;margin-bottom:14px;} .meta div span{color:#888;text-transform:uppercase;font-size:9.5px;letter-spacing:.5px;display:block;}' +
      'table{width:100%;border-collapse:collapse;} .g702 td{padding:5px 8px;border-bottom:1px solid #e5e7eb;} .g702 .ln{color:#888;width:26px;text-align:center;} .g702 tr.hi td{background:#eef4fb;font-weight:bold;color:#1B3A5C;}' +
      '.g703{font-size:10.5px;} .g703 th{background:#1B3A5C;color:#fff;padding:6px 5px;font-size:9px;text-transform:uppercase;letter-spacing:.3px;border:1px solid #16304d;} .g703 td{padding:4px 5px;border:1px solid #d5dbe3;} .g703 .n{text-align:right;font-variant-numeric:tabular-nums;} .g703 .c{text-align:center;} .g703 .b{font-weight:bold;} .g703 tr.tot td{background:#eef4fb;font-weight:bold;}' +
      '.sec{font-size:13px;font-weight:bold;color:#1B3A5C;margin:0 0 8px;} .cert{font-size:10.5px;color:#333;margin:16px 0;line-height:1.5;}' +
      '.sig{display:flex;gap:36px;margin-top:26px;} .sig .b{flex:1;} .sig .l{border-bottom:1px solid #333;height:30px;} .sig .cap{font-size:9.5px;color:#666;margin-top:3px;}' +
      '.bar{position:fixed;top:10px;right:10px;} .bar button{font:inherit;padding:8px 16px;border-radius:8px;border:0;background:#1B8541;color:#fff;cursor:pointer;font-weight:bold;}' +
      '@media print{.bar{display:none;} body{padding:0;}}' +
      '</style></head><body>' +
      '<div class="bar"><button onclick="window.print()">Print / Save PDF</button></div>' +
      // ---- G702 ----
      '<div class="page">' +
        '<div class="hd"><img src="' + esc(ctx.logo) + '" onerror="this.style.display=\'none\'"/>' +
          '<div class="t"><div class="doctitle">Application for Payment</div><div class="docsub">AIA G702 — Application &amp; Certificate</div></div></div>' +
        '<div class="meta">' +
          '<div><span>From (Contractor)</span>' + esc(ctx.contractor) + '</div>' +
          '<div><span>To (Owner)</span>' + esc(ctx.owner || '—') + '</div>' +
          '<div><span>Project</span>' + esc(ctx.project) + (ctx.address ? '<br>' + esc(ctx.address) : '') + '</div>' +
          '<div><span>Application No.</span>' + esc(app.app_no) + '</div>' +
          '<div><span>Period To</span>' + esc(fmtDate(app.period_to)) + '</div>' +
          '<div><span>Retainage</span>' + esc(app.retainage_pct) + '%</div>' +
        '</div>' +
        '<table class="g702">' +
          g702line(1, 'Original Contract Sum', s.original) +
          g702line(2, 'Net change by Change Orders', s.co) +
          g702line(3, 'Contract Sum to Date (1 &plusmn; 2)', s.contract, true) +
          g702line(4, 'Total Completed &amp; Stored to Date', s.completedStored) +
          g702line(5, 'Retainage', s.retainage) +
          g702line(6, 'Total Earned Less Retainage (4 &minus; 5)', s.earnedLessRet, true) +
          g702line(7, 'Less Previous Certificates for Payment', s.lessPrevious) +
          g702line(8, 'CURRENT PAYMENT DUE', s.dueThis, true) +
          g702line(9, 'Balance to Finish, incl. Retainage (3 &minus; 6)', bal9) +
        '</table>' +
        '<div class="cert">The undersigned Contractor certifies that to the best of the Contractor&rsquo;s knowledge, information and belief the Work covered by this Application for Payment has been completed in accordance with the Contract Documents, that all amounts have been paid by the Contractor for Work for which previous Certificates for Payment were issued and payments received from the Owner, and that current payment shown herein is now due.</div>' +
        '<div class="sig"><div class="b"><div class="l"></div><div class="cap">Contractor &mdash; ' + esc(ctx.contractor) + '</div></div>' +
          '<div class="b"><div class="l"></div><div class="cap">Date</div></div></div>' +
        '<div class="sig"><div class="b"><div class="l"></div><div class="cap">Owner / Architect &mdash; Amount Certified ' + fmtC(s.dueThis) + '</div></div>' +
          '<div class="b"><div class="l"></div><div class="cap">Date</div></div></div>' +
      '</div>' +
      // ---- G703 ----
      '<div class="page">' +
        '<div class="hd"><img src="' + esc(ctx.logo) + '" onerror="this.style.display=\'none\'"/>' +
          '<div class="t"><div class="doctitle">Continuation Sheet</div><div class="docsub">AIA G703 — Schedule of Values &middot; App No. ' + esc(app.app_no) + '</div></div></div>' +
        '<table class="g703"><thead><tr>' +
          '<th>#</th><th style="text-align:left;">Description of Work</th><th>Scheduled Value</th><th>From Previous</th><th>This Period</th>' +
          '<th>Materials Stored</th><th>Total Compl. &amp; Stored</th><th>%</th><th>Balance to Finish</th><th>Retainage</th>' +
        '</tr></thead><tbody>' + rows + totalRow + '</tbody></table>' +
        '<div style="font-size:9px;color:#888;margin-top:8px;">Columns: D (From Previous) + E (This Period) = G (Total Completed &amp; Stored). F (Materials Stored) is the portion of G presently stored but not yet installed.</div>' +
      '</div>' +
      '</body></html>';
    var w = window.open('', '_blank');
    if (!w) { toast('Allow pop-ups to open the printable PDF.', true); return; }
    w.document.open(); w.document.write(doc); w.document.close();
  }

  function loadSheetJS() {
    return new Promise(function (resolve, reject) {
      if (window.XLSX) return resolve(window.XLSX);
      var sc = document.createElement('script');
      sc.src = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js';
      sc.onload = function () { resolve(window.XLSX); };
      sc.onerror = function () { reject(new Error('Could not load the spreadsheet library.')); };
      document.head.appendChild(sc);
    });
  }
  function exportXLSX(app) {
    loadSheetJS().then(function (XLSX) {
      var s = computeSummary(app), ctx = docContext();
      var aoa = [
        ['Application for Payment (AIA G702 / G703)'],
        ['Contractor', ctx.contractor], ['Owner', ctx.owner || ''], ['Project', ctx.project], ['Address', ctx.address || ''],
        ['Application No.', app.app_no], ['Period To', fmtDate(app.period_to)], ['Retainage %', num(app.retainage_pct)], ['Status', app.status],
        [],
        ['G702 — Certificate Summary'],
        ['1  Original Contract Sum', num(s.original)],
        ['2  Net change by Change Orders', num(s.co)],
        ['3  Contract Sum to Date', num(s.contract)],
        ['4  Total Completed & Stored to Date', num(s.completedStored)],
        ['5  Retainage', num(s.retainage)],
        ['6  Total Earned Less Retainage', num(s.earnedLessRet)],
        ['7  Less Previous Certificates', num(s.lessPrevious)],
        ['8  CURRENT PAYMENT DUE', num(s.dueThis)],
        ['9  Balance to Finish incl. Retainage', round2(s.contract - s.earnedLessRet)],
        [],
        ['G703 — Schedule of Values'],
        ['#', 'Description of Work', 'Scheduled Value', 'From Previous', 'This Period', 'Materials Stored', 'Total Completed & Stored', '% (G/C)', 'Balance to Finish', 'Retainage']
      ];
      var lines = Array.isArray(app.lines) ? app.lines : [];
      var tot = { C: 0, D: 0, E: 0, F: 0, G: 0, bal: 0, I: 0 };
      lines.forEach(function (l, i) {
        var r = g703Row(l, app);
        tot.C += r.C; tot.D += r.D; tot.E += r.E; tot.F += r.F; tot.G += r.G; tot.bal += r.bal; tot.I += r.I;
        aoa.push([i + 1, (l.description || '') + (l.type === 'co' ? ' (CO)' : ''),
          num(r.C), num(r.D), num(r.E), num(r.F), num(r.G), Math.round(r.pctG * 10) / 10, num(r.bal), num(r.I)]);
      });
      aoa.push(['', 'GRAND TOTAL', num(tot.C), num(tot.D), num(tot.E), num(tot.F), num(tot.G),
        tot.C ? Math.round(tot.G / tot.C * 1000) / 10 : 0, num(tot.bal), num(tot.I)]);
      var ws = XLSX.utils.aoa_to_sheet(aoa);
      ws['!cols'] = [{ wch: 5 }, { wch: 40 }, { wch: 16 }, { wch: 14 }, { wch: 13 }, { wch: 15 }, { wch: 18 }, { wch: 9 }, { wch: 16 }, { wch: 13 }];
      var wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Pay App ' + app.app_no);
      var safe = String(ctx.jobNumber || ctx.project || 'job').replace(/[^\w]+/g, '_').slice(0, 24);
      XLSX.writeFile(wb, 'PayApp_' + app.app_no + '_' + safe + '.xlsx');
      toast('Excel downloaded.');
    }).catch(function (e) { toast((e && e.message) || 'Excel export failed.', true); });
  }

  // ── small UX utils (PWA-safe confirm + toast) ─────────────
  function doConfirm(title, message, onYes) {
    if (typeof window.p86Confirm === 'function') {
      var res = window.p86Confirm({ title: title, message: message, confirmText: 'Yes', cancelText: 'Cancel' });
      if (res && typeof res.then === 'function') { res.then(function (ok) { if (ok) onYes(); }); return; }
      if (res) onYes(); return;
    }
    if (window.confirm(message)) onYes();
  }
  function toast(msg, isErr) {
    if (typeof window.p86Toast === 'function') { window.p86Toast(msg, isErr ? 'error' : 'success'); return; }
    if (typeof window.showToast === 'function') { window.showToast(msg); return; }
    if (isErr && window.console) console.warn('[payapps]', msg);
  }

  // Flush a pending debounced save before the page is hidden/closed so an edit
  // made in the last <700ms isn't lost (pagehide/visibilitychange are the
  // mobile-safe teardown signals; in-app section switches are already covered
  // because the debounce timer keeps running against _st after navigation).
  try {
    window.addEventListener('pagehide', function () { if (_st.dirty) flushSave(); });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden' && _st.dirty) flushSave();
    });
  } catch (e) {}

  // ── exports ───────────────────────────────────────────────
  window.renderPayApps = renderPayApps;
  window.p86PayApps = {
    render: renderPayApps,
    refresh: function () { if (_st.jobId) load(_st.jobId); },
    // flush pending edits on teardown / job switch
    flush: function () { if (_st.dirty) flushSave(); }
  };
})();
