/* Project 86 — Buildertrend sync PREVIEW (Admin → Organization → Buildertrend preview).
   ─────────────────────────────────────────────────────────────
   READ-ONLY. Renders GET /api/admin/organizations/me?view=buildertrend-preview
   (server/services/clickr/sync-preview.js). The only request this page makes is
   that one GET; there is no control here that writes.

   Buildertrend is the source of truth, so every difference is the CORRECTION
   Project 86 would receive. Kept visibly apart from those:
     * Buildertrend blank — P86 keeps its value (never proposed);
     * held back — money (both figures) and job numbers (never proposed);
     * flagged — e.g. Warranty, which has no P86 status;
     * in P86, not in Buildertrend — review only, never proposed for deletion.

   The page must never look like an answer when it is not one: a failed
   dataset shows its sentence and no table; a partial read says so ABOVE the
   counts; "in P86, not in Buildertrend" says NOT RELIABLE unless the read was
   complete. Every server string reaches the DOM through esc().

   Jobs default to Buildertrend's Open + Warranty jobs (the ones a sync would
   act on); a toggle shows all. Tiles are recomputed from the rows under that
   toggle. Styling is theme tokens only, so light and dark both come from
   styles.css. */
(function () {
  'use strict';

  var ENDPOINT = '/api/admin/organizations/me?view=buildertrend-preview';
  var PAGE = 100;
  var CAND_SHOWN = 8;
  var LABEL = {
    matched: 'Would stay the same',
    conflict: 'Would be corrected',
    ambiguous: 'Ambiguous — needs a person',
    possible_duplicate: 'Possible duplicate — review',
    'new': 'Would be created in P86',
    change_order: 'Change-order rows',
    not_a_job: 'Not a job (no number)',
    refused: 'Refused (no name)',
    btblank: 'Buildertrend blank — P86 keeps',
    heldback: 'Held back (money / number)',
    flagged: 'Flagged',
    notinbt: 'In P86, not in Buildertrend'
  };
  var CHIP = { matched: 'Same', conflict: 'Corrected', ambiguous: 'Ambiguous', possible_duplicate: 'Possible duplicate', 'new': 'Create',
    change_order: 'Change order', not_a_job: 'Not a job', refused: 'Refused', notinbt: 'Not in BT' };
  var CLASS_ORDER = ['conflict', 'ambiguous', 'possible_duplicate', 'new', 'matched', 'change_order', 'not_a_job', 'refused'];

  var _host = null;
  var _data = null;
  var _err = null;
  var _loading = false;
  var _ui = {
    jobs: { f: 'all', scope: 'open', q: '', shown: PAGE },
    leads: { f: 'all', scope: 'all', q: '', shown: PAGE },
    clients: { f: 'all', scope: 'all', q: '', shown: PAGE }
  };
  // Apply (server/services/clickr/sync-apply.js). The server re-reads both
  // sides and re-matches; the page only says which Buildertrend ids to act on.
  var APPLY_ENDPOINT = '/api/admin/organizations/me?action=buildertrend-apply';
  var _applying = null;          // 'jobs:safe' | 'jobs:<btId>' | ...
  var _applyNote = { jobs: null, leads: null, clients: null };   // { ok, text }
  // What a person ticked, per row: _picks['jobs:<btId>'][field] = true/false.
  // Corrections start ticked; held-back items a person may apply start unticked.
  var _picks = {};
  var TABS = [['jobs', 'Jobs'], ['leads', 'Leads'], ['clients', 'Clients']];
  var NOUN = { jobs: 'job', leads: 'lead', clients: 'client' };
  var _tab = 'jobs';
  try { var _savedTab = window.localStorage && window.localStorage.getItem('btp.tab'); if (_savedTab === 'jobs' || _savedTab === 'leads' || _savedTab === 'clients') _tab = _savedTab; } catch (e) { /* storage blocked */ }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // The sentence shown when the request itself failed. Plain text; the caller
  // escapes it. A server 403/500 carries its own fixed sentence in `error`.
  function errorSentence(e) {
    var status = e && e.status;
    var serverMsg = e && e.data && typeof e.data.error === 'string' ? e.data.error : '';
    if (status === 403 && e.data && e.data.code === 'CLICKR_NOT_THIS_ORG') return serverMsg;
    if (status === 403) return 'Only an administrator of this organization can open the Buildertrend preview.' + (serverMsg ? ' (' + serverMsg + ')' : '');
    // js/api.js rejects a 2xx whose body is empty or not JSON with that 2xx
    // status: the request did not fail, its answer could not be read.
    if (status >= 200 && status < 300) return 'The server answered, but its response could not be read — it may be restarting after a deploy. Press Refresh in a minute.';
    if (status && serverMsg) return serverMsg;
    if (status) return 'The Buildertrend preview request failed (HTTP ' + status + ').';
    return 'The Buildertrend preview request did not complete' + (e && e.message ? ': ' + e.message : '.') ;
  }

  // A 200 that is not a preview — e.g. the previous server version, mid-deploy,
  // ignoring ?view and answering /me's plain {organization}. Plain text or null.
  function shapeError(d) {
    var ok = d && typeof d === 'object' && d.datasets && typeof d.datasets === 'object' &&
      d.datasets.jobs && typeof d.datasets.jobs === 'object' && d.datasets.leads && typeof d.datasets.leads === 'object';
    // A server that predates the Clients tab answers jobs + leads only: the tab then says so instead of breaking.
    return ok ? null : 'The server answered, but not with a Buildertrend preview — it may still be running the previous version during a deploy. Press Refresh in a minute.';
  }

  function injectStyles() {
    if (document.getElementById('btp-styles')) return;
    var css = [
      '.btp{font-size:13px;color:var(--text);}',
      '.btp-banner{border:1px solid var(--border);border-left:3px solid var(--accent);background:var(--card-bg);border-radius:8px;padding:10px 12px;margin:0 0 14px;line-height:1.45;}',
      '.btp-banner p{margin:4px 0 0;color:var(--text-dim);font-size:12px;}',
      '.btp-toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:0 0 12px;color:var(--text-dim);font-size:12px;}',
      '.btp-btn{border:1px solid var(--border);background:var(--surface);color:var(--text);border-radius:6px;padding:6px 12px;font-size:12px;font-weight:600;cursor:pointer;}',
      '.btp-btn:hover{background:var(--surface2);}',
      '.btp-ds{border:1px solid var(--border);border-radius:10px;background:var(--card-bg);padding:12px 14px;margin:0 0 16px;min-width:0;}',
      '.btp-ds-head{display:flex;justify-content:space-between;align-items:baseline;gap:8px;flex-wrap:wrap;}',
      '.btp-ds-title{font-size:15px;font-weight:700;}',
      '.btp-sub{color:var(--text-dim);font-size:12px;}',
      '.btp-sentence{margin:8px 0 10px;padding:8px 10px;border-radius:6px;border:1px solid var(--border);line-height:1.45;overflow-wrap:anywhere;}',
      '.btp-sentence.is-ok{border-left:3px solid var(--green);}',
      '.btp-sentence.is-warn{border-left:3px solid var(--yellow);}',
      '.btp-sentence.is-bad{border-left:3px solid var(--red);}',
      '.btp-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(118px,1fr));gap:8px;margin:0 0 10px;}',
      '.btp-tile{display:block;border:1px solid var(--border);border-radius:8px;padding:8px 10px;background:var(--surface);cursor:pointer;text-align:left;color:var(--text);font:inherit;min-width:0;white-space:normal;overflow-wrap:anywhere;}',
      '.btp-tile.is-active{outline:2px solid var(--accent);outline-offset:-1px;}',
      '.btp-tile.is-static{cursor:default;}',
      '.btp-tile-n{font-size:20px;font-weight:700;line-height:1.1;font-variant-numeric:tabular-nums;}',
      '.btp-tile-l{font-size:11px;color:var(--text-dim);text-transform:uppercase;letter-spacing:.3px;margin-top:2px;line-height:1.25;}',
      '.btp-tile-s{font-size:11px;color:var(--text-dim);margin-top:2px;}',
      '.c-matched{--btp-c:var(--green);}.c-conflict{--btp-c:var(--orange);}.c-ambiguous,.c-possible_duplicate{--btp-c:var(--yellow);}',
      '.c-new{--btp-c:var(--accent);}.c-change_order,.c-heldback{--btp-c:var(--purple);}.c-notinbt,.c-refused{--btp-c:var(--red);}',
      '.c-not_a_job,.c-btblank,.c-flagged{--btp-c:var(--text-dim);}',
      '.btp-tile .btp-tile-n{color:var(--btp-c,var(--text));}',
      '.btp-seg{display:inline-flex;border:1px solid var(--border);border-radius:6px;overflow:hidden;flex-wrap:wrap;}',
      '.btp-seg button{border:0;background:transparent;color:var(--text-dim);padding:5px 10px;font-size:12px;font-weight:600;cursor:pointer;}',
      '.btp-seg button.is-active{background:var(--surface2);color:var(--text);}',
      '.btp-filters{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:0 0 10px;}',
      '.btp-search{flex:1 1 160px;min-width:0;max-width:100%;border:1px solid var(--border);background:var(--input-bg);color:var(--text);border-radius:6px;padding:6px 10px;font-size:13px;}',
      '.btp-row{border:1px solid var(--border);border-radius:8px;padding:8px 10px;margin:0 0 8px;background:var(--surface);min-width:0;}',
      '.btp-row-head{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:0 0 6px;}',
      '.btp-chip{font-size:11px;font-weight:700;border-radius:10px;padding:1px 8px;border:1px solid currentColor;color:var(--btp-c,var(--text-dim));}',
      '.btp-rung{font-size:11px;color:var(--text-dim);}',
      '.btp-pair{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px;}',
      '.btp-side-l{font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:var(--text-dim);margin-bottom:2px;}',
      '.btp-name{font-weight:600;overflow-wrap:anywhere;}',
      '.btp-meta{color:var(--text-dim);font-size:12px;overflow-wrap:anywhere;}',
      '.btp-none{color:var(--text-dim);font-style:italic;}',
      '.btp-block{margin:8px 0 0;border-top:1px dashed var(--border);padding-top:6px;}',
      '.btp-block-l{font-size:10px;text-transform:uppercase;letter-spacing:.5px;font-weight:700;margin-bottom:3px;color:var(--btp-c,var(--text-dim));}',
      '.btp-fix{display:grid;grid-template-columns:minmax(80px,auto) minmax(0,1fr);gap:2px 10px;font-size:12px;margin:3px 0;}',
      '.btp-fix-f{font-weight:700;}',
      '.btp-from{color:var(--text-dim);text-decoration:line-through;overflow-wrap:anywhere;}',
      '.btp-to{font-weight:600;overflow-wrap:anywhere;}',
      '.btp-tag{display:inline-block;font-size:10px;font-weight:700;border-radius:8px;padding:0 6px;margin-left:4px;border:1px solid var(--border);color:var(--text-dim);vertical-align:1px;}',
      '.btp-tag.is-typo{color:var(--red);border-color:var(--red);}',
      '.btp-tag.is-linked{color:var(--green);border-color:var(--green);margin-left:auto;}',
      '.btp-tag.is-money{color:var(--purple);border-color:var(--purple);}',
      '.btp-pick{margin:0 6px 0 0;vertical-align:-2px;cursor:pointer;}',
      'label.btp-fix-f{cursor:pointer;display:flex;align-items:baseline;}',
      '.btp-tabs{display:flex;gap:4px;border-bottom:1px solid var(--border);margin:0 0 12px;flex-wrap:wrap;}',
      '.btp-tab{border:1px solid transparent;border-bottom:0;background:transparent;color:var(--text-dim);padding:7px 14px;font-size:13px;font-weight:600;cursor:pointer;border-radius:8px 8px 0 0;margin-bottom:-1px;}',
      '.btp-tab.is-active{background:var(--card-bg);color:var(--text);border-color:var(--border);}',
      '.btp-tab-n{display:inline-block;min-width:18px;padding:0 5px;margin-left:4px;border-radius:9px;background:var(--orange);color:#fff;font-size:11px;line-height:17px;text-align:center;}',
      '.btp-row-head .btp-apply{margin-left:auto;padding:3px 10px;}',
      '.btp-btn:disabled{opacity:.55;cursor:default;}',
      '.btp-fix-note{grid-column:2;color:var(--text-dim);font-size:11px;overflow-wrap:anywhere;}',
      '.btp-fix-note.is-typo{color:var(--red);}',
      '.btp-list{margin:0;padding-left:16px;font-size:12px;overflow-wrap:anywhere;}',
      '.btp-notes{margin-top:4px;font-size:11px;color:var(--text-dim);overflow-wrap:anywhere;}',
      '.btp-more{display:block;margin:6px auto 0;}',
      '.btp-diag{margin-top:10px;border-top:1px solid var(--border);padding-top:8px;}',
      '.btp-diag summary{cursor:pointer;color:var(--text-dim);font-size:12px;font-weight:600;}',
      '.btp-diag table{border-collapse:collapse;font-size:12px;width:100%;}',
      '.btp-diag th,.btp-diag td{border-bottom:1px solid var(--border);padding:4px 6px;text-align:left;vertical-align:top;}',
      '.btp-scroll{overflow-x:auto;}',
      '.btp-code{font-family:"SF Mono",Menlo,Consolas,monospace;font-size:11px;overflow-wrap:anywhere;}',
      '@media (max-width:640px){.btp-pair{grid-template-columns:minmax(0,1fr);}.btp-tile-n{font-size:17px;}.btp-ds{padding:10px;}.btp-tiles{grid-template-columns:repeat(2,minmax(0,1fr));}}'
    ].join('\n');
    var el = document.createElement('style');
    el.id = 'btp-styles';
    el.textContent = css;
    document.head.appendChild(el);
  }

  function load() {
    if (_loading) return;
    _loading = true;
    _err = null;
    paint();
    var req = (window.p86Api && typeof window.p86Api.get === 'function')
      ? window.p86Api.get(ENDPOINT)
      : Promise.reject(new Error('the API client is not loaded'));
    req.then(function (d) {
      var bad = shapeError(d);
      _data = bad ? null : d;
      _err = bad;
      _loading = false;
      paint();
    }).catch(function (e) {
      _loading = false;
      _err = errorSentence(e);
      paint();
    });
  }

  function addr(x) {
    var parts = [x.street, [x.city, x.state].filter(Boolean).join(', '), x.zip].filter(function (v) { return v && String(v).trim(); });
    return parts.join(' · ');
  }

  function inScope(ds, ui, r) {
    if (ds.key !== 'jobs' || ui.scope === 'all') return true;
    return r.bt && r.bt.scope === ui.scope;
  }

  function passesFilter(r, f) {
    if (f === 'all') return true;
    if (f === 'btblank') return (r.btBlank || []).length > 0;
    if (f === 'heldback') return (r.heldBack || []).length > 0;
    if (f === 'flagged') return (r.flags || []).length > 0;
    if (f === 'typo') return (r.corrections || []).some(function (c) { return !!c.typo; });
    return r['class'] === f;
  }

  function visibleRows(ds, ui) {
    var q = ui.q.trim().toLowerCase();
    return (ds.rows || []).filter(function (r) {
      if (!inScope(ds, ui, r) || !passesFilter(r, ui.f)) return false;
      if (!q) return true;
      var hay = [r.bt.raw, r.bt.contactName, r.bt.email, r.bt.street, r.bt.city, r.p86 && r.p86.title, r.p86 && r.p86.jobNumber, r.p86 && r.p86.email].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }

  function visibleNotInBt(ds, ui) {
    var q = ui.q.trim().toLowerCase();
    var nib = ds.notInBuildertrend;
    return ((nib && nib.rows) || []).filter(function (p) {
      if (!q) return true;
      return [p.jobNumber, p.title, p.client, p.email, p.street, p.city, p.status].join(' ').toLowerCase().indexOf(q) >= 0;
    });
  }

  function countsFor(ds, ui) {
    var c = { matched: 0, conflict: 0, ambiguous: 0, possible_duplicate: 0, 'new': 0, change_order: 0, not_a_job: 0, refused: 0,
      btblank: 0, heldback: 0, flagged: 0, typo: 0 };
    var fields = 0, formatOnly = 0, blankFields = 0;
    (ds.rows || []).forEach(function (r) {
      if (!inScope(ds, ui, r)) return;
      c[r['class']] = (c[r['class']] || 0) + 1;
      (r.corrections || []).forEach(function (x) { fields++; if (x.kind === 'format') formatOnly++; });
      if ((r.btBlank || []).length) { c.btblank++; blankFields += r.btBlank.length; }
      if ((r.heldBack || []).length) c.heldback++;
      if ((r.flags || []).length) c.flagged++;
      if ((r.corrections || []).some(function (x) { return !!x.typo; })) c.typo++;
    });
    var base = c.matched + c.conflict + c.ambiguous + c.possible_duplicate + c['new'];
    return { counts: c, fields: fields, formatOnly: formatOnly, blankFields: blankFields, base: base,
      rate: base ? (c.matched + c.conflict) / base : null };
  }

  function btSide(ds, r) {
    var bt = r.bt;
    var meta = [];
    if (ds.key === 'jobs') {
      meta.push('Status: ' + (bt.status ? esc(bt.status) : '<i>blank</i>'));
      var a = addr(bt);
      if (a) meta.push(esc(a));
      if (bt.projectedStart) meta.push('Start ' + esc(String(bt.projectedStart).slice(0, 10)));
      if (bt.contractText) meta.push('Contract ' + esc(bt.contractText));
    } else if (ds.key === 'clients') {
      if (bt.email) meta.push(esc(bt.email));
      if (bt.phone || bt.cell) meta.push(esc(bt.phone || bt.cell));
      var ca = addr(bt);
      if (ca) meta.push(esc(ca));
      if (bt.jobCount != null || bt.leadCount != null) meta.push(esc(bt.jobCount || 0) + ' jobs · ' + esc(bt.leadCount || 0) + ' leads in Buildertrend');
    } else {
      if (bt.contactName) meta.push('Contact: ' + esc(bt.contactName));
      if (bt.salesperson) meta.push('Sales: ' + esc(bt.salesperson));
      var la = addr(bt);
      if (la) meta.push(esc(la));
    }
    return '<div><div class="btp-side-l">Buildertrend (truth)</div>' +
      '<div class="btp-name">' + (bt.raw ? esc(bt.raw) : '<span class="btp-none">(no name)</span>') + '</div>' +
      (meta.length ? '<div class="btp-meta">' + meta.join(' · ') + '</div>' : '') + '</div>';
  }

  function p86Label(p, kind) {
    if (!p) return '';
    if (kind === 'jobs') return esc([p.jobNumber, p.title].filter(Boolean).join(' ') || p.id);
    return esc(p.title || p.id);
  }

  function candidatesHTML(ds, list, overflowNote) {
    list = list || [];
    var shown = list.slice(0, CAND_SHOWN);
    var html = '<ul class="btp-list">' + shown.map(function (c) {
      var bits = [];
      if (c.status) bits.push(esc(c.status));
      var a = addr(c);
      if (a) bits.push(esc(a));
      if (c.rungs && c.rungs.length) bits.push('via ' + c.rungs.map(esc).join(', '));
      return '<li>' + p86Label(c, ds.key) + (bits.length ? ' <span class="btp-meta">' + bits.join(' · ') + '</span>' : '') + '</li>';
    }).join('') + '</ul>';
    if (list.length > shown.length) {
      html += '<div class="btp-meta">and ' + (list.length - shown.length) + ' more (' + (overflowNote || 'all excluded from “not in Buildertrend”') + ')</div>';
    }
    return html;
  }

  function p86Side(ds, r) {
    var html = '<div><div class="btp-side-l">Project 86 now</div>';
    var cls = r['class'];
    if ((cls === 'matched' || cls === 'conflict') && r.p86) {
      var p = r.p86;
      var meta = [];
      if (p.status) meta.push(esc(p.status));
      var a = addr(p);
      if (a) meta.push(esc(a));
      if (ds.key === 'leads' && p.client) meta.push('Client: ' + esc(p.client));
      if (ds.key === 'clients' && p.email) meta.push(esc(p.email));
      html += '<div class="btp-name">' + p86Label(p, ds.key) + '</div>' + (meta.length ? '<div class="btp-meta">' + meta.join(' · ') + '</div>' : '');
    } else if (cls === 'change_order') {
      var par = r.parent;
      if (!par) html += '<div class="btp-none">No single parent job — maps to a P86 change order, never a job</div>';
      else if (par.p86Only) {
        html += '<div class="btp-meta">No Buildertrend parent row was read; P86 carries this number on</div>' +
          '<div class="btp-name">' + p86Label(par.p86, 'jobs') + '</div><div class="btp-meta">' + esc(par.p86ChangeOrders == null ? '?' : par.p86ChangeOrders) + ' change order(s) already in P86 on this job</div>';
      } else {
        html += '<div class="btp-meta">A change order on <b>' + esc(par.btRaw) + '</b></div>';
        html += par.p86
          ? '<div class="btp-name">' + p86Label(par.p86, 'jobs') + '</div><div class="btp-meta">' + esc(par.p86ChangeOrders == null ? '?' : par.p86ChangeOrders) + ' change order(s) already in P86 on this job</div>'
          : '<div class="btp-none">The parent has no confident P86 job (' + esc(LABEL[par['class']] || par['class']) + ')</div>';
      }
    } else if (cls === 'ambiguous' || cls === 'possible_duplicate') {
      html += '<div class="btp-meta">' + (cls === 'ambiguous' ? 'Candidates — nothing is proposed:' : 'Looks like — review before anything is created:') + '</div>' + candidatesHTML(ds, r.candidates);
    } else if (cls === 'new') {
      html += '<div class="btp-none">Not in P86 — a sync would create it</div>';
    } else {
      html += '<div class="btp-none">Not compared</div>';
    }
    return html + '</div>';
  }

  function canApply(r) {
    return (r['class'] === 'matched' || r['class'] === 'conflict') && r.bt && r.bt.btId != null && r.bt.btId !== '';
  }

  function picksFor(ds, r) {
    var k = ds.key + ':' + r.bt.btId;
    if (!_picks[k]) {
      var p = {};
      (r.corrections || []).forEach(function (c) { p[c.field] = true; });
      (r.heldBack || []).forEach(function (h) { if (h.applicable) p[h.field] = false; });
      _picks[k] = p;
    }
    return _picks[k];
  }

  function pickedFields(ds, r) {
    var p = picksFor(ds, r);
    return Object.keys(p).filter(function (f) { return p[f]; });
  }

  function pickBox(ds, r, field, checked) {
    if (!canApply(r)) return '';
    return '<input type="checkbox" class="btp-pick" data-btp-pick="' + esc(field) + '" data-btp-row="' + esc(r.bt.btId) + '"' + (checked ? ' checked' : '') +
      (_applying ? ' disabled' : '') + ' aria-label="Apply ' + esc(field) + '">';
  }

  function correctionsHTML(ds, r) {
    var list = r.corrections || [];
    if (!list.length) return '';
    var picks = canApply(r) ? picksFor(ds, r) : {};
    return '<div class="btp-block c-conflict"><div class="btp-block-l">Would be corrected to match Buildertrend' + (canApply(r) ? ' — untick anything you do not want applied' : '') + '</div>' +
      list.map(function (c) {
        var tag = c.kind === 'format' ? '<span class="btp-tag">formatting only</span>' : c.kind === 'fill' ? '<span class="btp-tag">P86 blank — fill</span>' : '';
        if (c.money) tag += '<span class="btp-tag is-money">money</span>';
        if (c.typo) tag += '<span class="btp-tag is-typo">probable BT typo</span>';
        var to = esc(c.to) + (c.toP86 ? ' <span class="btp-meta">(P86: ' + esc(c.toP86) + ')</span>' : '');
        return '<div class="btp-fix"><label class="btp-fix-f">' + pickBox(ds, r, c.field, picks[c.field] !== false) + esc(c.label || c.field) + '</label>' +
          '<div>' + (c.from ? '<span class="btp-from">' + esc(c.from) + '</span>' : '<span class="btp-none">blank</span>') +
          ' → <span class="btp-to">' + to + '</span>' + tag + '</div>' +
          (c.typo ? '<div class="btp-fix-note is-typo">' + esc(c.typo) + '</div>' : '') +
          (c.note ? '<div class="btp-fix-note">' + esc(c.note) + '</div>' : '') + '</div>';
      }).join('') + '</div>';
  }

  function blankHTML(r) {
    var list = r.btBlank || [];
    if (!list.length) return '';
    return '<div class="btp-block c-btblank"><div class="btp-block-l">Buildertrend blank — P86 keeps its value</div><ul class="btp-list">' +
      list.map(function (b) {
        return '<li><b>' + esc(b.label || b.field) + '</b>: P86 keeps “' + esc(b.p86) + '”' + (b.zero ? ' (Buildertrend shows 0)' : '') + '</li>';
      }).join('') + '</ul></div>';
  }

  function heldHTML(ds, r) {
    var list = r.heldBack || [];
    if (!list.length) return '';
    var picks = canApply(r) ? picksFor(ds, r) : {};
    return '<div class="btp-block c-heldback"><div class="btp-block-l">Never applied automatically' + (canApply(r) && list.some(function (h) { return h.applicable; }) ? ' — tick one to apply it on purpose' : '') + '</div>' +
      list.map(function (h) {
        var box = h.applicable ? pickBox(ds, r, h.field, picks[h.field] === true) : '';
        return '<div class="btp-fix"><label class="btp-fix-f">' + box + esc(h.label || h.field) + '</label>' +
          '<div>P86 ' + (h.p86 ? '<b>' + esc(h.p86) + '</b>' : '<span class="btp-none">blank</span>') + ' · Buildertrend <b>' + esc(h.bt) + '</b>' +
          '<span class="btp-tag">' + esc(h.reason) + '</span></div>' +
          (h.note ? '<div class="btp-fix-note">' + esc(h.note) + '</div>' : '') + '</div>';
      }).join('') + '</div>';
  }

  function flagsHTML(r) {
    var list = r.flags || [];
    if (!list.length) return '';
    return '<div class="btp-block c-flagged"><div class="btp-block-l">Flagged — not mapped</div><ul class="btp-list">' +
      list.map(function (f) { return '<li>' + esc(f.text) + '</li>'; }).join('') + '</ul></div>';
  }

  // P86 records a confident row reached but did not pick, and P86 records that
  // look like its counterpart (possible duplicates in P86). Neither is proposed.
  function alsoHTML(ds, r) {
    var html = '';
    if ((r.p86Duplicates || []).length) {
      html += '<div class="btp-block c-flagged"><div class="btp-block-l">Possible duplicates in P86 — not proposed, still listed under “' + esc(LABEL.notinbt) + '”</div>' +
        candidatesHTML(ds, r.p86Duplicates, 'all still listed under “not in Buildertrend”') + '</div>';
    }
    if ((r.considered || []).length) {
      html += '<div class="btp-block c-flagged"><div class="btp-block-l">Also considered in P86 — not chosen</div>' + candidatesHTML(ds, r.considered) + '</div>';
    }
    return html;
  }

  function rowHTML(ds, r) {
    var cls = r['class'];
    var head = '<span class="btp-chip c-' + esc(cls) + '">' + esc(CHIP[cls] || cls) + (r.bt.coLabel ? ' ' + esc(r.bt.coLabel) : '') + '</span>';
    if (r.rung) head += '<span class="btp-rung">via ' + esc(r.rung) + '</span>';
    if (ds.key === 'jobs' && r.bt.scope !== 'open') head += '<span class="btp-rung">' + esc(r.bt.scope === 'closed' ? 'Closed in Buildertrend' : 'no Buildertrend status') + '</span>';
    var notes = (r.notes || []).length ? '<div class="btp-notes">' + r.notes.map(esc).join(' · ') + '</div>' : '';
    head += applyButtonHTML(ds, r);
    return '<div class="btp-row"' + (canApply(r) ? ' data-btp-rowid="' + esc(r.bt.btId) + '"' : '') + '><div class="btp-row-head">' + head + '</div>' +
      '<div class="btp-pair">' + btSide(ds, r) + p86Side(ds, r) + '</div>' +
      correctionsHTML(ds, r) + heldHTML(ds, r) + blankHTML(r) + flagsHTML(r) + alsoHTML(ds, r) + notes + '</div>';
  }

  // Only confident rows (matched / conflict) with a Buildertrend id can be
  // applied. A row already linked by id with nothing to correct shows "Linked".
  function applyLabel(ds, r) {
    var linked = r.rung === 'Buildertrend ID';
    var n = pickedFields(ds, r).length;
    if (_applying === ds.key + ':' + r.bt.btId) return 'Applying…';
    if (n) return 'Apply ' + n + ' selected' + (linked ? '' : ' + link');
    return linked ? 'Nothing selected' : 'Link only';
  }

  function applyButtonHTML(ds, r) {
    if (!canApply(r)) return '';
    var linked = r.rung === 'Buildertrend ID';
    var selectable = (r.corrections || []).length + (r.heldBack || []).filter(function (h) { return h.applicable; }).length;
    if (!selectable && linked) return '<span class="btp-tag is-linked">Linked</span>';
    var n = pickedFields(ds, r).length;
    return '<button type="button" class="btp-btn btp-apply" data-btp-apply="' + esc(r.bt.btId) + '"' + (_applying || (!n && linked) ? ' disabled' : '') + '>' + applyLabel(ds, r) + '</button>';
  }

  function safeCount(ds) {
    return (ds.rows || []).filter(function (r) {
      if (r['class'] !== 'matched' && r['class'] !== 'conflict') return false;
      if (!r.bt || r.bt.btId == null || r.bt.btId === '') return false;
      if (r.rung !== 'Buildertrend ID') return true;
      return ds.key === 'jobs' && (r.corrections || []).some(function (c) { return c.field === 'startDate' && c.kind === 'fill'; });
    }).length;
  }

  function applyResultText(res) {
    var c = (res && res.counts) || {};
    var parts = [(c.applied || 0) + ' updated'];
    if (c.linked) parts.push(c.linked + ' newly linked');
    if (c.fields) parts.push(c.fields + ' field' + (c.fields === 1 ? '' : 's') + ' changed');
    if (c.unchanged) parts.push(c.unchanged + ' already up to date');
    if (c.skipped) parts.push(c.skipped + ' skipped');
    var stale = []; ((res && res.results) || []).forEach(function (x) { (x.stale || []).forEach(function (f) { stale.push(f); }); });
    if (stale.length) parts.push('not applied because P86 changed since the preview or it would clash: ' + stale.slice(0, 5).join(', '));
    if (c.failed) parts.push(c.failed + ' failed');
    var reasons = ((res && res.results) || []).filter(function (x) { return x.outcome === 'skipped' || x.outcome === 'failed'; })
      .slice(0, 3).map(function (x) { return (x.label ? '“' + x.label + '”: ' : '') + x.reason; });
    return parts.join(' · ') + '.' + (reasons.length ? ' ' + reasons.join(' ') : '');
  }

  function runApply(key, body) {
    if (_applying || !(window.p86Api && typeof window.p86Api.put === 'function')) return;
    _applying = key + ':' + (body.mode === 'safe' ? 'safe' : body.btIds[0]);
    if (body.mode !== 'safe') delete _picks[key + ':' + body.btIds[0]];
    _applyNote[key] = null;
    repaint(key);
    window.p86Api.put(APPLY_ENDPOINT, Object.assign({ dataset: key }, body)).then(function (res) {
      _applying = null;
      _applyNote[key] = { ok: true, text: applyResultText(res) };
      (res && res.results || []).forEach(function (x) { if (x.btId) delete _picks[key + ':' + x.btId]; });
      load();
    }).catch(function (e) {
      _applying = null;
      var msg = e && e.data && typeof e.data.error === 'string' ? e.data.error : 'The apply request failed' + (e && e.status ? ' (HTTP ' + e.status + ')' : '') + '.';
      _applyNote[key] = { ok: false, text: msg };
      repaint(key);
    });
  }

  function askThen(message, label, fn) {
    if (typeof window.p86Confirm === 'function') {
      Promise.resolve(window.p86Confirm({ title: 'Apply Buildertrend updates', message: message, confirmLabel: label, confirmText: label,
        cancelLabel: 'Cancel', cancelText: 'Cancel', danger: false, destructive: false })).then(function (ok) { if (ok) fn(); });
    } else if (window.confirm(message)) {
      fn();
    }
  }

  function notInBtRowHTML(ds, p) {
    var meta = [];
    if (p.status) meta.push(esc(p.status));
    if (ds.key === 'clients' && p.state86 === 'property') meta.push('property under a parent client in P86');
    if (p.email) meta.push(esc(p.email));
    if (p.client) meta.push('Client: ' + esc(p.client));
    var a = addr(p);
    if (a) meta.push(esc(a));
    return '<div class="btp-row"><div class="btp-row-head"><span class="btp-chip c-notinbt">' + esc(CHIP.notinbt) + '</span>' +
      '<span class="btp-rung">review only — never proposed for deletion</span></div>' +
      '<div class="btp-side-l">Project 86</div><div class="btp-name">' + p86Label(p, ds.key) + '</div>' +
      (meta.length ? '<div class="btp-meta">' + meta.join(' · ') + '</div>' : '') +
      ((p.resembles || []).length ? '<div class="btp-notes">Possible duplicate: looks like Buildertrend ' + p.resembles.map(function (x) {
        return '“' + esc(x.btRaw) + '”' + (x.matchedTo ? ' (matched to P86 ' + esc(x.matchedTo) + ')' : '');
      }).join(', ') + '.</div>' : '') + '</div>';
  }

  function diagnosticHTML(ds) {
    var f = ds.fetch || {};
    var m = ds.mapping;
    var html = '<details class="btp-diag"><summary>Read and mapping diagnostic</summary><div class="btp-scroll"><table><tbody>' +
      '<tr><th>Dataset id</th><td class="btp-code">' + esc(ds.datasetId) + '</td></tr>' +
      '<tr><th>Paging</th><td>' + esc(f.mode || '—') + ' · ' + esc(f.pages) + ' page(s) · ' + (f.complete ? 'complete' : 'partial') + '</td></tr>' +
      '<tr><th>Count Clickr reported</th><td>' + (f.reportedCount != null ? esc(f.reportedCount) : 'none') + '</td></tr>' +
      '<tr><th>Why partial</th><td>' + esc(f.reason || '—') + '</td></tr>' +
      '<tr><th>Time</th><td>' + esc(f.elapsedMs) + ' ms</td></tr></tbody></table></div>';
    if (m) {
      html += '<div class="btp-sub" style="margin:10px 0 4px;">Keys read (server/services/clickr/field-map.js) — * required</div>' +
        '<div class="btp-scroll"><table><thead><tr><th>Key</th><th>Carried by</th><th>Non-empty</th></tr></thead><tbody>' +
        m.fields.map(function (x) {
          return '<tr><td class="btp-code">' + esc(x.key) + (x.required ? ' *' : '') + '</td><td>' + (x.carriedBy ? esc(x.carriedBy) : '<b>missing</b>') + '</td><td>' + esc(x.nonEmpty) + '</td></tr>';
        }).join('') + '</tbody></table></div>';
      if (m.unexpectedKeys && m.unexpectedKeys.length) {
        html += '<div class="btp-sub" style="margin:10px 0 4px;">Other keys that arrived (not read)</div><div class="btp-code">' +
          m.unexpectedKeys.map(function (k) { return esc(k.key) + ' ×' + esc(k.carriedBy); }).join(' · ') + '</div>';
      }
    }
    return html + '</details>';
  }

  function tile(k, n, label, sub, active, isStatic) {
    var inner = '<div class="btp-tile-n">' + n + '</div><div class="btp-tile-l">' + label + '</div>' + (sub ? '<div class="btp-tile-s">' + sub + '</div>' : '');
    if (isStatic) return '<div class="btp-tile is-static c-' + k + '">' + inner + '</div>';
    return '<button type="button" class="btp-tile c-' + k + (active ? ' is-active' : '') + '" data-btp-f="' + k + '">' + inner + '</button>';
  }

  function datasetHTML(ds) {
    var ui = _ui[ds.key];
    var f = ds.fetch || {};
    var html = '<section class="btp-ds" data-btp-ds="' + esc(ds.key) + '">';
    html += '<div class="btp-ds-head"><div class="btp-ds-title">' + esc(ds.label) + '</div>' +
      '<div class="btp-sub">Fetched <b>' + esc(f.fetched || 0) + '</b> of <b>' + (f.reportedCount != null ? esc(f.reportedCount) : '?') + '</b>' +
      (f.complete ? '' : ' · <b>partial</b>') + '</div></div>';
    var sentenceCls = ds.error ? 'is-bad' : (f.complete ? 'is-ok' : 'is-warn');
    html += '<div class="btp-sentence ' + sentenceCls + '">' + esc(ds.error ? ds.error.message : ds.sentence) + '</div>';
    if (ds.error && ds.error.kind !== 'empty' && ds.sentence && ds.sentence !== ds.error.message && f.fetched) {
      html += '<div class="btp-sub">' + esc(ds.sentence) + '</div>';
    }
    if (ds.mapping && ds.mapping.missingKeys && ds.mapping.missingKeys.length && !ds.error) {
      html += '<div class="btp-sentence is-warn">Expected key' + (ds.mapping.missingKeys.length > 1 ? 's' : '') + ' carried by no record: <b>' +
        ds.mapping.missingKeys.map(esc).join(', ') + '</b>. Nothing can be proposed from ' + (ds.mapping.missingKeys.length > 1 ? 'them' : 'it') + '.</div>';
    }

    if (ds.classified) {
      var cc = countsFor(ds, ui);
      var nib = ds.notInBuildertrend || {};
      var sc = safeCount(ds);
      var busySafe = _applying === ds.key + ':safe';
      html += '<div class="btp-filters"><button type="button" class="btp-btn btp-apply" data-btp-apply-safe="1"' + (_applying || !sc || !f.complete ? ' disabled' : '') + '>' +
        (busySafe ? 'Applying…' : (ds.key === 'jobs' ? 'Link confident matches + fill blank start dates' : 'Link confident matches') + ' (' + sc + ')') + '</button>' +
        '<span class="btp-sub">' + (f.complete ? 'Saves the Buildertrend id on each confident match' + (ds.key === 'jobs' ? ' and fills a start date only where P86 has none' : '') + '. No other field changes.' : 'Needs a complete Buildertrend read.') + '</span></div>';
      var note = _applyNote[ds.key];
      if (note) html += '<div class="btp-sentence ' + (note.ok ? 'is-ok' : 'is-bad') + '">' + esc(note.text) + '</div>';
      if (ds.key === 'jobs') {
        html += '<div class="btp-filters"><div class="btp-seg" role="group" aria-label="Buildertrend job scope">' +
          [['open', 'Open + Warranty'], ['all', 'All jobs']].map(function (s) {
            return '<button type="button" data-btp-scope="' + s[0] + '" class="' + (ui.scope === s[0] ? 'is-active' : '') + '">' + s[1] + '</button>';
          }).join('') + '</div><span class="btp-sub">Scope is Buildertrend’s status. “Not in Buildertrend” is always checked against every job read.</span></div>';
      }
      html += '<div class="btp-tiles">';
      html += tile('conflict', cc.counts.conflict, esc(LABEL.conflict), cc.fields + ' field' + (cc.fields === 1 ? '' : 's') + (cc.formatOnly ? ' · ' + cc.formatOnly + ' formatting only' : ''), ui.f === 'conflict');
      html += tile('matched', cc.counts.matched, esc(LABEL.matched), '', ui.f === 'matched');
      html += tile('new', cc.counts['new'], esc(LABEL['new']), '', ui.f === 'new');
      html += tile('possible_duplicate', cc.counts.possible_duplicate, esc(LABEL.possible_duplicate), 'not created', ui.f === 'possible_duplicate');
      html += tile('ambiguous', cc.counts.ambiguous, esc(LABEL.ambiguous), 'proposes nothing', ui.f === 'ambiguous');
      html += tile('heldback', cc.counts.heldback, esc(LABEL.heldback), 'shown with both figures', ui.f === 'heldback');
      html += tile('btblank', cc.counts.btblank, esc(LABEL.btblank), cc.blankFields + ' field' + (cc.blankFields === 1 ? '' : 's'), ui.f === 'btblank');
      if (cc.counts.flagged) html += tile('flagged', cc.counts.flagged, esc(LABEL.flagged), 'not mapped', ui.f === 'flagged');
      html += tile('notinbt', esc(nib.count || 0), esc(LABEL.notinbt), nib.reliable ? 'review only' : 'NOT RELIABLE', ui.f === 'notinbt');
      if (ds.key === 'jobs') {
        html += tile('change_order', cc.counts.change_order, esc(LABEL.change_order), 'map to P86 change orders', ui.f === 'change_order');
        html += tile('not_a_job', cc.counts.not_a_job, esc(LABEL.not_a_job), 'not in the match rate', ui.f === 'not_a_job');
      }
      if (cc.counts.refused) html += tile('refused', cc.counts.refused, esc(LABEL.refused), 'never created', ui.f === 'refused');
      if (cc.counts.typo) html += tile('typo', cc.counts.typo, 'Probable BT typos', 'fix in Buildertrend', ui.f === 'typo');
      html += tile('rate', cc.rate == null ? '—' : Math.round(cc.rate * 100) + '%', 'Match rate', 'of ' + esc(cc.base), false, true);
      html += '</div>';

      var opts = ['all', 'conflict', 'ambiguous', 'possible_duplicate', 'new', 'matched'].concat(ds.key === 'jobs' ? ['change_order', 'not_a_job'] : [])
        .concat(['refused', 'heldback', 'btblank', 'flagged', 'notinbt']);
      html += '<div class="btp-filters"><select class="btp-search" style="flex:0 1 auto;" data-btp-fselect="1" aria-label="Show">' +
        opts.map(function (k) {
          return '<option value="' + k + '"' + (ui.f === k ? ' selected' : '') + '>' + (k === 'all' ? 'All Buildertrend records' : esc(LABEL[k])) + '</option>';
        }).join('') + (ui.f === 'typo' ? '<option value="typo" selected>Probable BT typos</option>' : '') + '</select>' +
        '<input type="search" class="btp-search" data-btp-q="1" placeholder="Search name, address, P86 number" value="' + esc(ui.q) + '">';

      var list;
      var render;
      if (ui.f === 'notinbt') {
        list = visibleNotInBt(ds, ui);
        render = function (p) { return notInBtRowHTML(ds, p); };
        html += '<span class="btp-sub">' + list.length + ' shown</span></div>';
        html += '<div class="btp-sentence ' + (nib.reliable ? 'is-ok' : 'is-warn') + '">' + esc(nib.sentence || '') + '</div>';
      } else {
        list = visibleRows(ds, ui).sort(function (a, b) { return CLASS_ORDER.indexOf(a['class']) - CLASS_ORDER.indexOf(b['class']); });
        render = function (r) { return rowHTML(ds, r); };
        html += '<span class="btp-sub">' + list.length + ' shown</span></div>';
      }
      html += '<div data-btp-list="1">' + list.slice(0, ui.shown).map(render).join('') + '</div>';
      if (list.length > ui.shown) {
        html += '<button type="button" class="btp-btn btp-more" data-btp-more="1">Show ' + Math.min(PAGE, list.length - ui.shown) + ' more of ' + (list.length - ui.shown) + ' remaining</button>';
      }
      html += '<div class="btp-sub" style="margin-top:6px;">Match rate = (would stay the same + would be corrected) ÷ (those + ambiguous + possible duplicates + would be created). Change orders, rows with no job number and refused rows are excluded.</div>';
    }
    html += diagnosticHTML(ds);
    return html + '</section>';
  }

  function pageHTML() {
    var html = '<div class="btp">';
    html += '<div class="btp-banner" role="note"><div><b>Nothing changes until you press Apply</b> — and nothing is ever written to Buildertrend.</div>' +
      '<p>Buildertrend is the source of truth, so each difference is shown as the correction Project 86 would receive. ' +
      'A blank in Buildertrend never overwrites a P86 value. Money and job numbers are held back and never applied. Ambiguous matches propose nothing and cannot be applied. Nothing is created or deleted. ' +
      'Applying saves the Buildertrend id on the P86 record, so later reads find it by id.</p></div>';
    html += '<div class="btp-toolbar"><button type="button" class="btp-btn" data-btp-refresh="1"' + (_loading ? ' disabled' : '') + '>' + (_loading ? 'Loading…' : 'Refresh') + '</button>';
    if (_data && _data.generatedAt) html += '<span>Generated ' + esc(new Date(_data.generatedAt).toLocaleString()) + ' · ' + esc(_data.elapsedMs) + ' ms</span>';
    html += '</div>';
    if (_loading && !_data) html += '<div class="btp-sub" style="padding:20px 0;">Reading every page from Clickr and comparing — this can take up to half a minute…</div>';
    var shapeErr = _data ? shapeError(_data) : null;
    if (_err) html += '<div class="btp-sentence is-bad">' + esc(_err) + '</div>';
    else if (shapeErr) html += '<div class="btp-sentence is-bad">' + esc(shapeErr) + '</div>';
    if (_data && !shapeErr) {
      var p = _data.p86 || {};
      html += '<div class="btp-sub" style="margin:0 0 10px;">Project 86 side: ' + esc(p.jobs) + ' jobs, ' + esc(p.leads) + ' leads' + (p.clients != null ? ' and ' + esc(p.clients) + ' clients' : '') + ' in ' + esc(_data.organization && _data.organization.name) + '.' +
        (p.unscopedJobs || p.unscopedLeads ? ' ' + esc(p.unscopedJobs) + ' jobs and ' + esc(p.unscopedLeads) + ' leads carry no organization — counted for review, never matched.' : '') + '</div>';
      if (p.error) html += '<div class="btp-sentence is-bad">' + esc(p.error) + '</div>';
      html += '<div class="btp-tabs" role="tablist">' + TABS.map(function (t) {
        var d = _data.datasets && _data.datasets[t[0]];
        var waiting = d && d.rows ? d.rows.filter(function (r) { return r['class'] === 'conflict' && canApply(r); }).length : 0;
        return '<button type="button" role="tab" class="btp-tab' + (_tab === t[0] ? ' is-active' : '') + '" aria-selected="' + (_tab === t[0]) + '" data-btp-tab="' + t[0] + '">' +
          t[1] + (waiting ? ' <span class="btp-tab-n">' + waiting + '</span>' : '') + '</button>';
      }).join('') + '</div>';
      if (_data.datasets && _data.datasets[_tab]) html += datasetHTML(_data.datasets[_tab]);
      else html += '<div class="btp-sentence is-warn">This server has not sent the ' + esc(_tab) + ' comparison yet — it may still be running the previous version. Press Refresh in a minute.</div>';
    }
    return html + '</div>';
  }

  function paint() {
    if (!_host || !document.body.contains(_host)) return;
    injectStyles();
    _host.innerHTML = pageHTML();
    wire();
  }

  function repaint(key) {
    var active = document.activeElement;
    var refocus = active && active.getAttribute && active.getAttribute('data-btp-q');
    var pos = refocus ? active.selectionStart : null;
    paint();
    if (refocus) {
      var el = _host.querySelector('[data-btp-ds="' + key + '"] [data-btp-q]');
      if (el) { el.focus(); try { el.setSelectionRange(pos, pos); } catch (e) { /* ignore */ } }
    }
  }

  function wire() {
    var r = _host.querySelector('[data-btp-refresh]');
    if (r) r.addEventListener('click', load);
    Array.prototype.forEach.call(_host.querySelectorAll('[data-btp-tab]'), function (b) {
      b.addEventListener('click', function () {
        _tab = b.getAttribute('data-btp-tab');
        try { if (window.localStorage) window.localStorage.setItem('btp.tab', _tab); } catch (e) { /* storage blocked */ }
        paint();
      });
    });
    Array.prototype.forEach.call(_host.querySelectorAll('[data-btp-ds]'), function (sec) {
      var key = sec.getAttribute('data-btp-ds');
      var ui = _ui[key];
      Array.prototype.forEach.call(sec.querySelectorAll('[data-btp-f]'), function (b) {
        b.addEventListener('click', function () { var k = b.getAttribute('data-btp-f'); ui.f = ui.f === k ? 'all' : k; ui.shown = PAGE; repaint(key); });
      });
      Array.prototype.forEach.call(sec.querySelectorAll('[data-btp-scope]'), function (b) {
        b.addEventListener('click', function () { ui.scope = b.getAttribute('data-btp-scope'); ui.shown = PAGE; repaint(key); });
      });
      var sel = sec.querySelector('[data-btp-fselect]');
      if (sel) sel.addEventListener('change', function () { ui.f = sel.value; ui.shown = PAGE; repaint(key); });
      var q = sec.querySelector('[data-btp-q]');
      if (q) q.addEventListener('input', function () { ui.q = q.value; ui.shown = PAGE; repaint(key); });
      var more = sec.querySelector('[data-btp-more]');
      if (more) more.addEventListener('click', function () { ui.shown += PAGE; repaint(key); });
      Array.prototype.forEach.call(sec.querySelectorAll('[data-btp-apply]'), function (b) {
        b.addEventListener('click', function () {
          var id = b.getAttribute('data-btp-apply');
          var ds = _data && _data.datasets && _data.datasets[key];
          var row = ds && (ds.rows || []).filter(function (x) { return String(x.bt.btId) === id; })[0];
          var fields = row ? pickedFields(ds, row) : [];
          var money = row ? (row.corrections || []).concat(row.heldBack || []).filter(function (x) { return fields.indexOf(x.field) !== -1 && (x.money || x.reason === 'money' || x.field === 'jobNumber'); }) : [];
          var go = function () { runApply(key, { btIds: [id], fields: fields }); };
          if (money.length) {
            askThen('Apply ' + money.map(function (x) { return (x.label || x.field) + ' → ' + (x.to || x.bt); }).join(', ') + ' to this ' + (NOUN[key] || 'record') + '?', 'Apply', go);
          } else {
            go();
          }
        });
      });
      Array.prototype.forEach.call(sec.querySelectorAll('[data-btp-pick]'), function (cb) {
        cb.addEventListener('change', function () {
          var id = cb.getAttribute('data-btp-row');
          var ds = _data && _data.datasets && _data.datasets[key];
          var row = ds && (ds.rows || []).filter(function (x) { return String(x.bt.btId) === id; })[0];
          if (!row) return;
          picksFor(ds, row)[cb.getAttribute('data-btp-pick')] = cb.checked;
          var btn = sec.querySelector('[data-btp-apply="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]');
          if (btn) { btn.textContent = applyLabel(ds, row); btn.disabled = !!_applying || (!pickedFields(ds, row).length && row.rung === 'Buildertrend ID'); }
        });
      });
      var safe = sec.querySelector('[data-btp-apply-safe]');
      if (safe) {
        safe.addEventListener('click', function () {
          var ds = _data && _data.datasets && _data.datasets[key];
          var n = ds ? safeCount(ds) : 0;
          askThen('Link ' + n + ' confident ' + (NOUN[key] || 'record') + ' match' + (n === 1 ? '' : 'es') + ' to Buildertrend' +
            (key === 'jobs' ? ' and fill start dates where P86 has none' : '') + '? No other field changes.', 'Apply', function () {
            runApply(key, { mode: 'safe' });
          });
        });
      }
    });
  }

  function mount(host) {
    _host = host;
    if (!host) return;
    if (_data || _loading) paint();
    else load();
  }

  window.p86BtSyncPreview = {
    mount: mount,
    reload: load,
    // For test/clickr-sync-preview.test.js: the escaping, the failure sentence,
    // and the whole page rendered from a given response, with no DOM.
    _test: {
      esc: esc,
      errorSentence: errorSentence,
      render: function (data, err) { _data = data || null; _err = err || null; _loading = false; return pageHTML(); },
      setView: function (key, f, scope) { _ui[key].f = f || 'all'; if (scope) _ui[key].scope = scope; _ui[key].shown = PAGE; },
      setTab: function (t) { _tab = t; },
      resetPicks: function () { _picks = {}; },
      shapeError: shapeError
    }
  };
})();
