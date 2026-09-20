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
   toggle. One exception, and it is the important one: a confident job row that
   carries a status correction, a held-back status item or a status flag is in
   scope whichever way the toggle is set. Closing a job is the commonest status
   change Buildertrend makes, and it moves the row out of "Open + Warranty" — so
   the correction it produces must not sit behind a toggle nobody presses.
   Styling is theme tokens only, so light and dark both come from styles.css.

   NEW / CHANGED SINCE YOUR LAST REFRESH (server/services/clickr/since-refresh.js):
   the server compares each complete Buildertrend read with what it remembered
   and marks rows against THIS admin's previous refresh, then moves that admin's
   marker. The page holds no copy of the marks: every load replaces _data. The
   reload after an Apply asks the server not to move the marker (?since=keep),
   so applying one row does not wipe the marks still being worked through.

   THE OVERVIEW TAB (the first one) answers "what do I do next, and in what
   order" out of the SAME response, with no extra request: the dependency
   chain (which Buildertrend job, once it is a linked P86 job, unblocks how
   many change orders, purchase orders, bills and estimate worksheets), the
   work grouped by what a person does rather than by dataset, the money at
   stake as proposals, and the read's own health. Every count it prints is the
   length of the list its own button lands on — see countTarget(). */
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
    notinbt: 'In P86, not in Buildertrend',
    typo: 'Probable BT typos',
    creatable: 'Would be created by one press',
    closed_new: 'Closed in Buildertrend — created one at a time',
    waiting: 'Waiting on its job',
    waitjob: 'Waiting on one Buildertrend job',
    money: 'Money waiting for a tick',
    refused_only: 'Refused for another reason',
    since_new: 'New since your last refresh',
    since_changed: 'Changed since your last refresh'
  };
  var CHIP = { matched: 'Same', conflict: 'Corrected', ambiguous: 'Ambiguous', possible_duplicate: 'Possible duplicate', 'new': 'Create',
    change_order: 'Change order', not_a_job: 'Not a job', refused: 'Refused', notinbt: 'Not in BT' };
  var CLASS_ORDER = ['conflict', 'ambiguous', 'possible_duplicate', 'new', 'matched', 'change_order', 'not_a_job', 'refused'];

  var _host = null;
  var _data = null;
  var _err = null;
  var _loading = false;
  var _ui = {
    jobs: { f: 'all', scope: 'open', q: '', waitJob: '', waitJobLabel: '', shown: PAGE },
    leads: { f: 'all', scope: 'all', q: '', waitJob: '', waitJobLabel: '', shown: PAGE },
    clients: { f: 'all', scope: 'all', q: '', waitJob: '', waitJobLabel: '', shown: PAGE },
    changeOrders: { f: 'all', scope: 'all', q: '', waitJob: '', waitJobLabel: '', shown: PAGE },
    purchaseOrders: { f: 'all', scope: 'all', q: '', waitJob: '', waitJobLabel: '', shown: PAGE },
    bills: { f: 'all', scope: 'all', q: '', waitJob: '', waitJobLabel: '', shown: PAGE },
    estimates: { f: 'all', scope: 'all', q: '', waitJob: '', waitJobLabel: '', shown: PAGE },
    tasks: { f: 'all', scope: 'all', q: '', waitJob: '', waitJobLabel: '', shown: PAGE }
  };
  // Apply (server/services/clickr/sync-apply.js). The server re-reads both
  // sides and re-matches; the page only says which Buildertrend ids to act on.
  var APPLY_ENDPOINT = '/api/admin/organizations/me?action=buildertrend-apply';
  var _applying = null;          // 'jobs:safe' | 'jobs:<btId>' | ...
  var _applyNote = { jobs: null, leads: null, clients: null, changeOrders: null, purchaseOrders: null, bills: null, estimates: null, tasks: null };   // { ok, text }
  // What a person ticked, per row: _picks['jobs:<btId>'][field] = true/false.
  // Corrections start ticked; held-back items a person may apply start unticked.
  var _picks = {};
  var TABS = [['overview', 'Overview'], ['jobs', 'Jobs'], ['leads', 'Leads'], ['clients', 'Clients'], ['changeOrders', 'Change orders'], ['purchaseOrders', 'Purchase orders'], ['bills', 'Bills'], ['estimates', 'Estimates'], ['tasks', 'Tasks'], ['archive', 'Archive']];
  var ARCHIVE_ENDPOINT = '/api/admin/organizations/me?view=buildertrend-archive';
  var _archive = null;       // [{ kind, id, label, reason, mergedInto, archivedAt, attached, deletable }]
  var _archiveErr = null;
  var _archiveNote = null;
  var NOUN = { jobs: 'job', leads: 'lead', clients: 'client', changeOrders: 'change order', purchaseOrders: 'purchase order', bills: 'bill', estimates: 'estimate', tasks: 'task' };
  var _tab = 'overview';
  try { var _savedTab = window.localStorage && window.localStorage.getItem('btp.tab'); if (_savedTab === 'overview' || _savedTab === 'jobs' || _savedTab === 'leads' || _savedTab === 'clients' || _savedTab === 'changeOrders' || _savedTab === 'purchaseOrders' || _savedTab === 'bills' || _savedTab === 'estimates' || _savedTab === 'tasks' || _savedTab === 'archive') _tab = _savedTab; } catch (e) { /* storage blocked */ }

  // The three datasets that hang off a linked JOB rather than standing alone.
  // Their P86 side is reviewed in P86, never archived from here, and their
  // "refused" bucket is mostly "its job is not linked yet".
  var DETAIL_KINDS = { changeOrders: 1, purchaseOrders: 1, bills: 1, estimates: 1, tasks: 1 };

  // What the Show box calls the view it is in, including the Overview's own
  // filters and the one that names a single Buildertrend job.
  function filterName(ds, ui) {
    if (ui.f === 'waitjob') return 'Waiting on ' + (ui.waitJobLabel || 'one Buildertrend job');
    return labelFor(ds, ui.f) || ui.f;
  }

  // A change order is "refused" mostly because its job is not linked yet.
  function labelFor(ds, k) {
    if (ds && DETAIL_KINDS[ds.key] && k === 'refused') return 'Waiting on its job';
    return LABEL[k];
  }

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
      '.c-since_new{--btp-c:var(--accent);}.c-since_changed{--btp-c:var(--orange);}',
      '.btp-tab-new{display:inline-block;padding:0 6px;margin-left:4px;border-radius:9px;border:1px solid var(--accent);color:var(--accent);background:transparent;font-size:11px;font-weight:700;line-height:15px;white-space:nowrap;}',
      '.btp-removed{margin:0 0 10px;font-size:12px;}',
      '.btp-removed summary{cursor:pointer;color:var(--text-dim);font-weight:600;}',
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
      '.btp-tag.is-permanent{color:var(--red);border-color:var(--red);}',
      '.btp-pick{margin:0 6px 0 0;vertical-align:-2px;cursor:pointer;}',
      'label.btp-fix-f{cursor:pointer;display:flex;align-items:baseline;}',
      '.btp-tabs{display:flex;gap:4px;border-bottom:1px solid var(--border);margin:0 0 12px;flex-wrap:wrap;}',
      '.btp-tab{border:1px solid transparent;border-bottom:0;background:transparent;color:var(--text-dim);padding:7px 14px;font-size:13px;font-weight:600;cursor:pointer;border-radius:8px 8px 0 0;margin-bottom:-1px;}',
      '.btp-tab.is-active{background:var(--card-bg);color:var(--text);border-color:var(--border);}',
      '.btp-tab-n{display:inline-block;min-width:18px;padding:0 5px;margin-left:4px;border-radius:9px;background:var(--orange);color:#fff;font-size:11px;line-height:17px;text-align:center;}',
      '.btp-row-head .btp-apply{margin-left:auto;padding:3px 10px;}',
      '.btp-link{padding:1px 8px;font-size:11px;margin-left:6px;}',
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
      '.btp-run{border:1px dashed var(--border);border-radius:10px;background:var(--surface);padding:10px 12px;margin:0 0 14px;color:var(--text-dim);font-size:12px;line-height:1.5;}',
      '.btp-run b{color:var(--text);}',
      '.btp-dash-sec{border:1px solid var(--border);border-radius:10px;background:var(--card-bg);padding:12px 14px;margin:0 0 16px;min-width:0;}',
      '.btp-dash-h{font-size:15px;font-weight:700;}',
      '.btp-dash-w{color:var(--text-dim);font-size:12px;line-height:1.45;margin:3px 0 10px;}',
      '.btp-lead{font-size:13px;line-height:1.55;margin:0 0 10px;}',
      '.btp-grp{border:1px solid var(--border);border-radius:8px;background:var(--surface);padding:8px 10px;margin:0 0 8px;}',
      '.btp-grp-h{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;}',
      '.btp-grp-n{font-size:22px;font-weight:700;line-height:1.1;font-variant-numeric:tabular-nums;color:var(--btp-c,var(--text));}',
      '.btp-grp-t{font-size:13px;font-weight:700;}',
      '.btp-grp-w{color:var(--text-dim);font-size:12px;line-height:1.45;margin:2px 0 6px;}',
      '.btp-parts{display:flex;gap:6px;flex-wrap:wrap;}',
      '.btp-part{border:1px solid var(--border);background:var(--surface2);color:var(--text);border-radius:14px;padding:3px 10px;font:inherit;font-size:12px;cursor:pointer;text-align:left;min-width:0;overflow-wrap:anywhere;}',
      '.btp-part:hover{border-color:var(--accent);}',
      '.btp-part-n{font-weight:700;font-variant-numeric:tabular-nums;}',
      '.btp-part-s{color:var(--text-dim);}',
      '.btp-linkish{border:0;background:transparent;color:var(--accent);font:inherit;padding:0;cursor:pointer;text-align:inherit;text-decoration:underline;overflow-wrap:anywhere;}',
      '.btp-linkish:hover{color:var(--text);}',
      '.btp-dep{width:100%;border-collapse:collapse;font-size:12px;}',
      '.btp-dep th,.btp-dep td{border-bottom:1px solid var(--border);padding:5px 6px;text-align:left;vertical-align:top;}',
      '.btp-dep th{color:var(--text-dim);font-size:10px;text-transform:uppercase;letter-spacing:.3px;font-weight:700;}',
      '.btp-dep .btp-num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;}',
      '.btp-act,.btp-hbadge{display:inline-block;font-size:11px;font-weight:700;border-radius:10px;padding:1px 8px;border:1px solid var(--btp-c,var(--border));color:var(--text);white-space:nowrap;}',
      '.a-link{--btp-c:var(--green);}.a-create{--btp-c:var(--accent);}.a-decide{--btp-c:var(--yellow);}',
      '.a-stuck,.a-missing{--btp-c:var(--red);}.a-linked{--btp-c:var(--text-dim);}',
      '.btp-dep-why,.btp-why{margin:8px 0 0;font-size:12px;color:var(--text-dim);line-height:1.5;}',
      '.btp-dep-why b,.btp-why b{color:var(--text);}',
      '.btp-money{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:8px;}',
      '.btp-mcard{border:1px solid var(--border);border-radius:8px;background:var(--surface);padding:8px 10px;min-width:0;}',
      '.btp-mn{font-size:19px;font-weight:700;line-height:1.15;font-variant-numeric:tabular-nums;color:var(--btp-c,var(--text));}',
      '.btp-health{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:8px;}',
      '.btp-hrow{border:1px solid var(--border);border-radius:8px;background:var(--surface);padding:8px 10px;min-width:0;}',
      '.btp-hrow .btp-row-head{margin:0 0 4px;}',
      '.btp-hrow .btp-link{margin-left:auto;}',
      '@media (max-width:640px){.btp-pair{grid-template-columns:minmax(0,1fr);}.btp-tile-n{font-size:17px;}.btp-ds{padding:10px;}.btp-tiles{grid-template-columns:repeat(2,minmax(0,1fr));}.btp-dash-sec{padding:10px;}.btp-dep{font-size:11px;}.btp-money,.btp-health{grid-template-columns:minmax(0,1fr);}}'
    ].join('\n');
    var el = document.createElement('style');
    el.id = 'btp-styles';
    el.textContent = css;
    document.head.appendChild(el);
  }

  // opts.keepMarker: the reload after an Apply — compared with the admin's last
  // refresh like any load, without becoming their new last refresh.
  function load(opts) {
    if (_loading) return;
    _loading = true;
    _err = null;
    paint();
    var url = ENDPOINT + (opts && opts.keepMarker === true ? '&since=keep' : '');
    var req = (window.p86Api && typeof window.p86Api.get === 'function')
      ? window.p86Api.get(url)
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

  // A confident job row that carries anything about STATUS — a correction, a
  // held-back item or a flag. The commonest Buildertrend status change there is
  // closes a job, which moves its row to the "closed" scope: under the default
  // "Open + Warranty" its "status -> Completed" correction was invisible unless
  // someone thought to switch to "All jobs". Such a row is IN SCOPE whatever
  // the toggle says.
  function carriesStatusItem(ds, r) {
    if (ds.key !== 'jobs') return false;
    var cls = r['class'];
    if (cls !== 'matched' && cls !== 'conflict') return false;
    var aboutStatus = function (x) { return !!x && x.field === 'status'; };
    return (r.corrections || []).some(aboutStatus) ||
      (r.heldBack || []).some(aboutStatus) ||
      (r.flags || []).some(aboutStatus);
  }

  // THE one place scope is decided: the rows, the tiles, the counts, the
  // filters and the "new since your last refresh" count all ask this.
  function inScope(ds, ui, r) {
    if (ds.key !== 'jobs' || ui.scope === 'all') return true;
    if (r.bt && r.bt.scope === ui.scope) return true;
    return carriesStatusItem(ds, r);
  }

  // A dashboard button and a tile reach their rows through ONE function, so
  // a count printed on the Overview and the list it lands on cannot drift.
  // Every filter above the fence is untouched; the six below are additive.
  function passesFilter(ds, r, f, ui) {
    if (f === 'all') return true;
    if (f === 'btblank') return (r.btBlank || []).length > 0;
    if (f === 'heldback') return (r.heldBack || []).length > 0;
    if (f === 'flagged') return (r.flags || []).length > 0;
    if (f === 'typo') return (r.corrections || []).some(function (c) { return !!c.typo; });
    if (f === 'since_new') return !!(r.since && r.since.state === 'new');
    if (f === 'since_changed') return !!(r.since && r.since.state === 'changed');
    // ── the Overview's own targets ──
    // Exactly what one press of this tab's Create button would make.
    if (f === 'creatable') return isCreatable(ds, r);
    // Closed in Buildertrend: never in that press, made one at a time from its row.
    if (f === 'closed_new') return ds.key === 'jobs' && r['class'] === 'new' && !r.createBlocked
      && r.bt && r.bt.btId != null && r.bt.btId !== '' && r.bt.scope !== 'open';
    if (f === 'waiting') return r.waitingOnJob === true;
    // Waiting on ONE named Buildertrend job — the dependency chain's click.
    if (f === 'waitjob') return r.waitingOnJob === true && waitKey(r) === ((ui && ui.waitJob) || '');
    if (f === 'money') return hasTickableMoney(r);
    // Refused for a reason OTHER than a job that is not linked: those are their own group.
    if (f === 'refused_only') return r['class'] === 'refused' && r.waitingOnJob !== true;
    return r['class'] === f;
  }

  function visibleRows(ds, ui) {
    var q = ui.q.trim().toLowerCase();
    return (ds.rows || []).filter(function (r) {
      if (!inScope(ds, ui, r) || !passesFilter(ds, r, ui.f, ui)) return false;
      if (!q) return true;
      var hay = [r.bt.raw, r.bt.contactName, r.bt.email, r.bt.street, r.bt.city, r.bt.jobName, r.job && r.job.label, r.p86 && r.p86.title, r.p86 && r.p86.jobNumber, r.p86 && r.p86.coNumber, r.p86 && r.p86.poNumber, r.p86 && r.p86.billNumber, r.bt.billNumber, r.bt.vendorName, r.p86 && r.p86.subName, r.bt.subName, r.p86 && r.p86.email].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }

  function visibleNotInBt(ds, ui) {
    var q = ui.q.trim().toLowerCase();
    var nib = ds.notInBuildertrend;
    return ((nib && nib.rows) || []).filter(function (p) {
      if (!q) return true;
      return [p.jobNumber, p.coNumber, p.poNumber, p.billNumber, p.jobLabel, p.title, p.client, p.email, p.street, p.city, p.status].join(' ').toLowerCase().indexOf(q) >= 0;
    });
  }

  function countsFor(ds, ui) {
    var c = { matched: 0, conflict: 0, ambiguous: 0, possible_duplicate: 0, 'new': 0, change_order: 0, not_a_job: 0, refused: 0,
      btblank: 0, heldback: 0, flagged: 0, typo: 0, since_new: 0, since_changed: 0 };
    var fields = 0, formatOnly = 0, blankFields = 0;
    (ds.rows || []).forEach(function (r) {
      if (!inScope(ds, ui, r)) return;
      c[r['class']] = (c[r['class']] || 0) + 1;
      (r.corrections || []).forEach(function (x) { fields++; if (x.kind === 'format') formatOnly++; });
      if ((r.btBlank || []).length) { c.btblank++; blankFields += r.btBlank.length; }
      if ((r.heldBack || []).length) c.heldback++;
      if ((r.flags || []).length) c.flagged++;
      if ((r.corrections || []).some(function (x) { return !!x.typo; })) c.typo++;
      if (r.since && r.since.state === 'new') c.since_new++;
      if (r.since && r.since.state === 'changed') c.since_changed++;
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
    } else if (ds.key === 'changeOrders') {
      if (bt.jobName) meta.push('Job: ' + esc(bt.jobName));
      meta.push('Status: ' + (bt.statusText ? esc(bt.statusText) : '<i>blank</i>'));
      meta.push('Price ' + esc(bt.priceText) + ' · cost ' + esc(bt.costText));
    } else if (ds.key === 'purchaseOrders') {
      if (bt.jobName) meta.push('Job: ' + esc(bt.jobName));
      meta.push('Status: ' + (bt.statusText ? esc(bt.statusText) : '<i>blank</i>') + (bt.workStatusText ? ' · work ' + esc(bt.workStatusText) : ''));
      meta.push('Cost ' + esc(bt.costText));
      // The close offer turns on Buildertrend's PAID status exactly. Printing
      // it is not decoration: without it the page asks for a permanent press
      // on a fact it never shows.
      if (bt.paidStatusText) meta.push('Paid: ' + esc(bt.paidStatusText));
      if (bt.subName) meta.push('Sub/vendor: ' + esc(bt.subName));
    } else if (ds.key === 'bills') {
      if (bt.jobName) meta.push('Job: ' + esc(bt.jobName));
      meta.push('Payment: ' + (bt.paymentStatusText ? esc(bt.paymentStatusText) : '<i>blank</i>'));
      // All three figures, always. The amount is the only one P86 can take, and
      // the other two are what the held-back settlement items are measured
      // against — a page that asks for a money press has to show the money.
      meta.push('Amount ' + esc(bt.amountText) + ' · paid ' + esc(bt.paidText) + ' · owing ' + esc(bt.remainingText));
      if (bt.vendorName) meta.push('Pay to: ' + esc(bt.vendorName));
      if ((bt.relatedPurchaseOrderIds || []).length) meta.push('BT purchase order' + (bt.relatedPurchaseOrderIds.length === 1 ? ' ' : 's ') + esc(bt.relatedPurchaseOrderIds.join(', ')));
      if (bt.dueDate) meta.push('Due ' + esc(String(bt.dueDate).slice(0, 10)));
    } else if (ds.key === 'tasks') {
      if (bt.jobName) meta.push('Job: ' + esc(bt.jobName));
      // BOTH FIELDS, ALWAYS, AND LABELLED. Clickr sends two things that read
      // like completion and disagree — isCompleted (the task) and status (the
      // to-do LIST). This page shows the flag that decides it and the word that
      // does not, side by side, because a page that printed only "Completed"
      // would be printing the field this whole tab is braced against.
      meta.push('Completed: ' + esc(bt.doneText) + (bt.completedDay ? ' on ' + esc(bt.completedDay) : ''));
      meta.push('BT list status: ' + (bt.statusText ? esc(bt.statusText) : '<i>blank</i>') + ' <span class="btp-none">(not completion)</span>');
      if (bt.dueDay) meta.push('Due ' + esc(bt.dueDay));
      if ((bt.assigneeNames || []).length) meta.push('Assigned: ' + esc(bt.assigneeNames.join(', ')));
      if (bt.notes) meta.push('Has notes');
    } else if (ds.key === 'estimates') {
      if (bt.jobName) meta.push('Job: ' + esc(bt.jobName));
      // A ROW IS A WORKSHEET AND A RECORD IS A LINE, so the line count is not
      // decoration: it is the only thing on the page that says how many Clickr
      // records this one row was folded from.
      meta.push(bt.lineCount + ' line item' + (bt.lineCount === 1 ? '' : 's')
        + (bt.deletedCount ? ' (' + bt.deletedCount + ' deleted, left out)' : ''));
      meta.push('Cost ' + esc(bt.costText) + ' · owner price ' + esc(bt.ownerText));
      meta.push('Contract ' + esc(bt.contractText));
      if (bt.proposalStatus) meta.push('Proposal: ' + esc(bt.proposalStatus));
      if (bt.worksheetLocked) meta.push('Locked in Buildertrend');
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
    if (kind === 'changeOrders') return esc([p.coNumber, p.title].filter(Boolean).join(' ') || p.id);
    if (kind === 'purchaseOrders') return esc([p.poNumber, p.title].filter(Boolean).join(' ') || p.id);
    if (kind === 'bills') return esc([p.billNumber, p.title].filter(Boolean).join(' ') || p.id);
    if (kind === 'estimates') return esc(p.title || p.id);
    return esc(p.title || p.id);
  }

  function candidatesHTML(ds, list, overflowNote, row) {
    list = list || [];
    var shown = list.slice(0, CAND_SHOWN);
    var html = '<ul class="btp-list">' + shown.map(function (c) {
      var bits = [];
      if (c.status) bits.push(esc(c.status));
      var a = addr(c);
      if (a) bits.push(esc(a));
      if (c.rungs && c.rungs.length) bits.push('via ' + c.rungs.map(esc).join(', '));
      var linkBtn = '';
      if (row && row.bt && row.bt.btId != null && row.bt.btId !== '') {
        if (row['class'] !== 'matched' && row['class'] !== 'conflict') {
          linkBtn = ' <button type="button" class="btp-btn btp-link" data-btp-link="' + esc(row.bt.btId) + '" data-btp-link-p86="' + esc(c.id) + '"' + (_applying ? ' disabled' : '') + '>Link to this one</button>';
        } else if (row.rung === 'Buildertrend ID' && row.p86) {
          linkBtn = ' <button type="button" class="btp-btn btp-link" data-btp-merge="' + esc(c.id) + '" data-btp-merge-into="' + esc(row.p86.id) + '" data-btp-merge-label="' + esc(c.title || c.id) + '"' + (_applying ? ' disabled' : '') + '>Merge into this record</button>';
        }
      }
      return '<li>' + p86Label(c, ds.key) + (bits.length ? ' <span class="btp-meta">' + bits.join(' · ') + '</span>' : '') + linkBtn + '</li>';
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
      // Buildertrend's OWN word, which applying saves on the P86 record
      // (data.btStatus). P86 has no Warranty and no Pending, so without this a
      // Warranty job reads "In Progress" and a pending change order reads
      // "draft" with nothing to tell it from a Buildertrend draft.
      if (ds.key === 'jobs' && r.bt.status) meta.push('Buildertrend: ' + esc(r.bt.status));
      if (ds.key === 'changeOrders') {
        if (r.bt.statusText) meta.push('Buildertrend: ' + esc(r.bt.statusText));
        if (r.job) meta.push('on ' + esc(r.job.label));
        meta.push('Price ' + esc(p.incomeText || '?') + ' · cost ' + esc(p.costsText || '?'));
      }
      if (ds.key === 'purchaseOrders') {
        // P86's own "approved" means the sub e-signed. Buildertrend's three
        // approvals all land on it, so which one it was is said out loud.
        if (r.bt.approvalKind) meta.push('Approved in Buildertrend ' + (r.bt.approvalKind === 'sub' ? 'by the sub' : 'internally'));
        if (r.job) meta.push('on ' + esc(r.job.label));
        meta.push('Cost ' + esc(p.totalText || '?') + (p.subName ? ' · ' + esc(p.subName) : ''));
      }
      if (ds.key === 'estimates') {
        if (r.bt.proposalStatus) meta.push('Buildertrend: ' + esc(r.bt.proposalStatus));
        if (r.job) meta.push('on ' + esc(r.job.label));
        meta.push(p.lineCount + ' line' + (p.lineCount === 1 ? '' : 's') + (p.costText ? ' · cost ' + esc(p.costText) : '') + (p.priceText ? ' · price ' + esc(p.priceText) : ''));
        if (p.alternates > 1) meta.push(p.alternates + ' alternates');
        // THE GUARD, ON THE PAGE. A row that proposes nothing has to say why,
        // or it reads as a row with nothing to do.
        if (p.lifecycle) meta.push('Sent or sold — ' + esc(p.lifecycle));
      }
      if (ds.key === 'tasks') {
        if (r.job) meta.push('on ' + esc(r.job.label));
        if (p.archived) meta.push('Archived in P86');
        if (p.dueDate) meta.push('Due ' + esc(p.dueDate));
        meta.push(p.assigneeName ? 'Assigned: ' + esc(p.assigneeName) : 'Unassigned');
        // THE GUARD, ON THE PAGE. A row whose text proposes nothing has to say
        // why, or it reads as a row with nothing to do.
        if (p.edited) meta.push('A person wrote this task — its words are not rewritten');
      }
      if (ds.key === 'bills') {
        if (r.bt.paymentStatusText) meta.push('Buildertrend: ' + esc(r.bt.paymentStatusText));
        if (r.job) meta.push('on ' + esc(r.job.label));
        meta.push('Amount ' + esc(p.amountText || '?') + (p.poNumber ? ' · PO ' + esc(p.poNumber) : ' · no PO') + (p.subName ? ' · ' + esc(p.subName) : ''));
      }
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
      html += '<div class="btp-meta">' + (cls === 'ambiguous' ? 'Candidates — nothing is proposed:' : 'Looks like — review before anything is created:') + '</div>' + candidatesHTML(ds, r.candidates, null, r);
    } else if (cls === 'new') {
      html += r.createBlocked ? '<div class="btp-none">Not in P86 — not created, see the note below</div>'
        : '<div class="btp-none">Not in P86 — a sync would create it' + (r.job ? ' on ' + esc(r.job.label) : '') + '</div>';
      // The estimates already on this job that nothing matched. Not candidates
      // and not a guess — the server refuses to choose between them — but a
      // person can, and without these buttons that decision has no door.
      // ESTIMATES ONLY: this copy says "this worksheet", and a lead row now
      // carries a considered list too (the P86 leads at the same property).
      // That one is rendered once, by alsoHTML, with the same link buttons.
      if (ds.key === 'estimates' && (r.considered || []).length) {
        html += '<div class="btp-meta">Already on this job — link this worksheet to one instead of creating a second:</div>'
          + candidatesHTML(ds, r.considered, null, r);
      }
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
          '<span class="btp-tag' + (h.reason === 'permanent' ? ' is-permanent' : '') + '">' + esc(h.reason) + '</span></div>' +
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
      html += '<div class="btp-block c-flagged"><div class="btp-block-l">Possible duplicates in P86' + (r.rung === 'Buildertrend ID' ? ' — merge a true duplicate into this record; the emptied copy goes to the Archive tab' : ' — apply or link this row first to merge a duplicate into it') + '</div>' +
        candidatesHTML(ds, r.p86Duplicates, 'all still listed under “not in Buildertrend”', r) + '</div>';
    }
    if ((r.considered || []).length) {
      html += '<div class="btp-block c-flagged"><div class="btp-block-l">Also considered in P86 — not chosen</div>' + candidatesHTML(ds, r.considered, null, r) + '</div>';
    }
    return html;
  }

  // "New" / "Changed" in Buildertrend since this admin's last refresh.
  function sinceChipHTML(r) {
    var s = r.since;
    if (!s) return '';
    if (s.state === 'new') return '<span class="btp-chip c-since_new" data-btp-since-chip="new" title="First seen in Buildertrend since your last refresh">New</span>';
    if (s.state === 'changed') return '<span class="btp-chip c-since_changed" data-btp-since-chip="changed" title="Changed in Buildertrend since your last refresh">Changed</span>';
    return '';
  }

  function sinceValue(v) {
    return v == null || v === '' ? '<span class="btp-none">blank</span>' : esc(v);
  }

  function sinceChangesHTML(r) {
    var s = r.since;
    if (!s || s.state !== 'changed' || !(s.changes || []).length) return '';
    return '<div class="btp-block c-since_changed" data-btp-since-changes="1"><div class="btp-block-l">Changed in Buildertrend since your last refresh</div><ul class="btp-list">' +
      s.changes.map(function (c) {
        return '<li><b>' + esc(c.label || c.field) + '</b>: ' + sinceValue(c.from) + ' → ' + sinceValue(c.to) + '</li>';
      }).join('') + '</ul></div>';
  }

  function sinceCompared(ds) {
    return !!(ds && ds.since && ds.since.compared === true);
  }

  // New + changed rows of a dataset, under the same scope rule as its tiles.
  function sinceCount(ds, ui) {
    if (!sinceCompared(ds)) return 0;
    return (ds.rows || []).filter(function (r) {
      return r.since && (r.since.state === 'new' || r.since.state === 'changed') && inScope(ds, ui, r);
    }).length;
  }

  // The dataset's sentence about the comparison, and what left Buildertrend.
  function sinceHTML(ds) {
    var s = ds.since;
    if (!s) return '';
    if (s.unavailable) {
      return '<div class="btp-sentence is-warn" data-btp-since="unavailable">Not compared with your last refresh this time — what is new or changed could not be worked out. Refresh again in a moment.</div>';
    }
    if (!s.compared) {
      return '<div class="btp-sentence ' + (s.partial ? 'is-warn' : 'is-ok') + '" data-btp-since="' + (s.partial ? 'partial' : 'first') + '">' + esc(s.note || '') + '</div>';
    }
    var when = s.previousRefreshAt ? new Date(s.previousRefreshAt).toLocaleString() : '';
    var html = '<div class="btp-sentence is-ok" data-btp-since="compared">Compared with your last refresh, ' + esc(when) + '.</div>';
    var gone = s.removed || [];
    if (gone.length) {
      var total = s.removedTotal != null && s.removedTotal > gone.length ? s.removedTotal : gone.length;
      html += '<details class="btp-removed" data-btp-removed="1"><summary>No longer in Buildertrend since your last refresh (' + esc(total) + ')</summary><ul class="btp-list">' +
        gone.map(function (g) { return '<li>' + esc(g.label) + '</li>'; }).join('') + '</ul>' +
        (total > gone.length ? '<div class="btp-meta">and ' + esc(total - gone.length) + ' more</div>' : '') + '</details>';
    }
    return html;
  }

  function rowHTML(ds, r) {
    var cls = r['class'];
    var head = '<span class="btp-chip c-' + esc(cls) + '">' + esc(CHIP[cls] || cls) + (r.bt.coLabel ? ' ' + esc(r.bt.coLabel) : '') + '</span>' + sinceChipHTML(r);
    if (r.rung) head += '<span class="btp-rung">via ' + esc(r.rung) + '</span>';
    if (ds.key === 'jobs' && r.bt.scope !== 'open') head += '<span class="btp-rung">' + esc(r.bt.scope === 'closed' ? 'Closed in Buildertrend' : 'no Buildertrend status') + '</span>';
    var notes = (r.notes || []).length ? '<div class="btp-notes">' + r.notes.map(esc).join(' · ') + '</div>' : '';
    if (r.p86Linked) {
      notes = '<div class="btp-block c-heldback"><div class="btp-block-l">Project 86 still has the record linked to this one</div>' +
        '<div class="btp-name">' + esc([r.p86Linked.billNumber, r.p86Linked.status, r.p86Linked.amountText].filter(Boolean).join(' · ')) + '</div>' +
        '<div class="btp-fix-note">Nothing is proposed for it, and a sync never deletes or voids a P86 record. Decide in P86.</div></div>' + notes;
    }
    head += applyButtonHTML(ds, r);
    return '<div class="btp-row"' + (canApply(r) ? ' data-btp-rowid="' + esc(r.bt.btId) + '"' : '') + '><div class="btp-row-head">' + head + '</div>' +
      sinceChangesHTML(r) + '<div class="btp-pair">' + btSide(ds, r) + p86Side(ds, r) + '</div>' +
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
    if (r['class'] === 'new' && !r.createBlocked && r.bt && r.bt.btId != null && r.bt.btId !== '') {
      var busyNew = _applying === ds.key + ':create:' + r.bt.btId;
      return '<button type="button" class="btp-btn btp-apply" data-btp-create="' + esc(r.bt.btId) + '"' + (_applying ? ' disabled' : '') + '>' + (busyNew ? 'Creating…' : 'Create in P86') + '</button>';
    }
    if (!canApply(r)) return '';
    var linked = r.rung === 'Buildertrend ID';
    var selectable = (r.corrections || []).length + (r.heldBack || []).filter(function (h) { return h.applicable; }).length;
    if (!selectable && linked) return '<span class="btp-tag is-linked">Linked</span>';
    var n = pickedFields(ds, r).length;
    return '<button type="button" class="btp-btn btp-apply" data-btp-apply="' + esc(r.bt.btId) + '"' + (_applying || (!n && linked) ? ' disabled' : '') + '>' + applyLabel(ds, r) + '</button>';
  }

  // A confident row the safe press would still LINK. The safe button counts more
  // than this (see safeCount), so the confirm names links and the rest apart.
  function unlinkedConfidentCount(ds) {
    return ((ds && ds.rows) || []).filter(function (r) {
      return (r['class'] === 'matched' || r['class'] === 'conflict') && r.bt && r.bt.btId != null && r.bt.btId !== '' && r.rung !== 'Buildertrend ID';
    }).length;
  }

  // A confident job or change order whose Buildertrend word has moved since P86
  // recorded it (r.btStatusDue, from the matcher). A row whose two sides agree
  // carries no correction at all: without counting it here a linked one would
  // offer nothing to press ever again, and P86 would keep the word it was
  // linked with. (Warranty and Pending used to be the standing example — P86
  // now has both statuses, so they are ordinary agreeing rows.)
  function statusWordCount(ds) {
    if (!ds || (ds.key !== 'jobs' && ds.key !== 'changeOrders' && ds.key !== 'bills' && ds.key !== 'estimates' && ds.key !== 'tasks')) return 0;
    return (ds.rows || []).filter(function (r) {
      return (r['class'] === 'matched' || r['class'] === 'conflict') && r.bt && r.bt.btId != null && r.bt.btId !== '' && r.btStatusDue === true;
    }).length;
  }

  // A confident purchase order P86 has approved whose stored approval does not
  // yet say WHICH Buildertrend approval it was (the sub's or the builder's own).
  function approvalKindCount(ds) {
    if (!ds || ds.key !== 'purchaseOrders') return 0;
    return (ds.rows || []).filter(function (r) {
      return (r['class'] === 'matched' || r['class'] === 'conflict') && r.bt && r.bt.btId != null && r.bt.btId !== '' && r.approvalKindDue === true;
    }).length;
  }

  function safeCount(ds) {
    return (ds.rows || []).filter(function (r) {
      if (r['class'] !== 'matched' && r['class'] !== 'conflict') return false;
      if (!r.bt || r.bt.btId == null || r.bt.btId === '') return false;
      if (r.rung !== 'Buildertrend ID') return true;
      if (ds.key === 'purchaseOrders' && (r.subAccessDue === true || r.approvalKindDue === true)) return true;
      if (r.btStatusDue === true) return true;
      return ds.key === 'jobs' && (r.corrections || []).some(function (c) { return c.field === 'startDate' && c.kind === 'fill'; });
    }).length;
  }

  // Purchase orders a safe apply gives sub portal access: a confident match whose
  // P86 PO is sent or approved with a sub of this organization that the server
  // read as having no access to the job's files yet — a linked, up-to-date PO
  // included, so POs synced before the sync granted access can still get it here.
  function subAccessCount(ds) {
    if (!ds || ds.key !== 'purchaseOrders') return 0;
    return (ds.rows || []).filter(function (r) {
      return (r['class'] === 'matched' || r['class'] === 'conflict') && r.bt && r.bt.btId != null && r.bt.btId !== '' && r.subAccessDue === true;
    }).length;
  }

  // NOTHING ELSE CHANGES used to be the whole promise. A safe press now also
  // records Buildertrend's OWN word beside the P86 status (jobs, change orders)
  // and which Buildertrend approval a committed purchase order carries, so both
  // are named. No P86 status and no money move either way.
  function safeConfirmText(key, ds) {
    var l = unlinkedConfidentCount(ds);
    var TAIL = ' No P86 status, money or other field changes.';
    if (key === 'purchaseOrders') {
      var a = subAccessCount(ds);
      var k = approvalKindCount(ds);
      var access = 'The sub of ' + a + ' sent or approved purchase order' + (a === 1 ? '' : 's') + ' gets portal access to the job’s files, as on the PO page — including where that access was removed by hand.';
      var kind = k ? ' Records which Buildertrend approval ' + k + ' committed purchase order' + (k === 1 ? '' : 's') + ' carr' + (k === 1 ? 'ies' : 'y') + ': the sub’s, or the builder’s own.' : '';
      // Nothing left to link (every confident match is already linked): say only what the press does.
      if (!l) return access + kind + ' Nothing is linked and no P86 status, money or other field changes.';
      return 'Link ' + l + ' confident purchase order match' + (l === 1 ? '' : 'es') + ' to Buildertrend?' + TAIL + ' ' + access + kind;
    }
    var w = statusWordCount(ds);
    var noun = NOUN[key] || 'record';
    var word = w ? ' Records what Buildertrend now calls ' + w + ' ' + noun + (w === 1 ? '' : 's') + ', beside the P86 status, which does not change.' : '';
    if (!l) return 'Nothing is left to link.' + word + (key === 'jobs' ? ' Start dates are filled only where P86 has none.' : '') + TAIL;
    return 'Link ' + l + ' confident ' + noun + ' match' + (l === 1 ? '' : 'es') + ' to Buildertrend' +
      (key === 'jobs' ? ' and fill start dates where P86 has none' : '') + '?' + word + TAIL;
  }

  // What the safe press does, named. Every value in it is a count this page
  // computed, so there is nothing here to escape.
  function safeSubText(ds) {
    var t = 'Saves the Buildertrend id on each confident match' + (ds.key === 'jobs' ? ' and fills a start date only where P86 has none' : '') + '.';
    var w = statusWordCount(ds);
    if (w) t += ' Records what Buildertrend now calls ' + w + ' ' + (NOUN[ds.key] || 'record') + (w === 1 ? '' : 's') + ', beside the P86 status, which does not change.';
    if (ds.key === 'estimates') {
      t += ' An estimate’s LINE ITEMS are applied one row at a time and only when you tick them: they carry every cost and every price on the proposal.'
        + ' Nothing is written into a P86 estimate that was sent to a client or sold — those take the Buildertrend id and nothing else.'
        + ' No P86 estimate is created or deleted by this press.';
    }
    if (ds.key === 'bills') {
      t += ' A bill’s amount, its bill number and its purchase order are applied one row at a time, and its amount only when you tick it.' +
        ' No P86 bill is created, voided or deleted by this press.';
    }
    if (ds.key === 'tasks') {
      t += ' NO MONEY IS INVOLVED ON THIS TAB — a task carries no cost, no price and no contract.' +
        ' What it carries is a commitment somebody acts on, so NOTHING on a task is applied by this press except the Buildertrend id:' +
        ' completing a task, retitling it, and replacing notes or a due date P86 already holds are each ticked by name on their own row.' +
        ' No P86 task is created, completed, archived, deleted or re-assigned by this press.';
    }
    if (ds.key === 'purchaseOrders') {
      t += ' The sub of each sent or approved PO without portal access to the job’s files yet gets it, as on the PO page (' + subAccessCount(ds) + ').';
      var k = approvalKindCount(ds);
      if (k) t += ' Records which Buildertrend approval ' + k + ' committed purchase order' + (k === 1 ? '' : 's') + ' carr' + (k === 1 ? 'ies' : 'y') + ': the sub’s, or the builder’s own.';
    }
    t += ' No P86 status, money or other field changes.';
    // The scope buttons filter the LIST; this press covers the whole read, as
    // "Not in Buildertrend" does. Said out loud, the way the create button says
    // closed jobs are created one at a time.
    if (ds.key === 'jobs') t += ' Every confident match counts here, including Buildertrend jobs the scope above hides.';
    return t;
  }

  function createAllConfirmText(key, ds) {
    var n = ds ? createCount(ds) : 0;
    var extra = '';
    if (key === 'changeOrders' && ds) {
      var approvedN = (ds.rows || []).filter(function (x) { return x['class'] === 'new' && !x.createBlocked && /^\s*approved\s*$/i.test(x.bt.statusText || ''); }).length;
      extra = ' ' + approvedN + ' of them are approved in Buildertrend and will join their job’s contract.';
    }
    if (key === 'purchaseOrders' && ds) {
      var committed = (ds.rows || []).filter(function (x) { return x['class'] === 'new' && !x.createBlocked && x.bt.state86 && x.bt.state86 !== 'draft'; }).length;
      extra = ' ' + committed + ' of them are sent or approved in Buildertrend, so they are created committed and their cost accrues on the job. Where one has a P86 sub, that sub gets portal access to the job’s files, as on the PO page.';
    }
    if (key === 'estimates' && ds) {
      var lineN = (ds.rows || []).filter(function (x) { return x['class'] === 'new'; })
        .reduce(function (n, x) { return n + (x.bt.lineCount || 0); }, 0);
      extra = ' Each becomes a real P86 estimate on its linked job, with Buildertrend’s own ' + lineN + ' line item' + (lineN === 1 ? '' : 's')
        + ' and section groups, and is born unsent, unlocked and not approved. Deleted Buildertrend lines are left out.';
    }
    if (key === 'tasks' && ds) {
      var doneN = (ds.rows || []).filter(function (x) { return x['class'] === 'new' && x.bt.state86 === 'done'; }).length;
      var unassignedN = (ds.rows || []).filter(function (x) { return x['class'] === 'new' && !(x.bt.assigneeNames || []).length; }).length;
      extra = ' No money is involved: a task carries no cost, no price and no contract. Each becomes an org task on its linked P86 job, visible to the whole team.' +
        ' ' + doneN + ' of them are finished in Buildertrend and are created done. ' + unassignedN + ' name nobody in Buildertrend;' +
        ' any whose assignee is not exactly one P86 user is created UNASSIGNED rather than guessed at.';
    }
    if (key === 'bills' && ds) {
      var paidN = (ds.rows || []).filter(function (x) { return x['class'] === 'new' && x.bt.state86 === 'paid'; }).length;
      extra = ' Each is created on its linked P86 job at Buildertrend’s amount, which is real money owed: it accrues on the job and counts toward its purchase order’s %-billed. ' +
        paidN + ' of them are already paid in Buildertrend and are created paid.';
    }
    return 'Create ' + n + ' ' + (key === 'jobs' ? 'open and warranty job' : (NOUN[key] || 'record')) + (n === 1 ? '' : 's') + ' in Project 86 from Buildertrend? Each is linked by its Buildertrend id.' + extra;
  }

  // ONE definition of "what the Create press makes" — isCreatable(), in the
  // Overview block below. The button's count and the dashboard's cannot drift.
  function createCount(ds) {
    return (ds.rows || []).filter(function (r) { return isCreatable(ds, r); }).length;
  }

  function applyResultText(res) {
    var c = (res && res.counts) || {};
    if (res && (res.mode === 'merge' || res.mode === 'archive' || res.mode === 'restore' || res.mode === 'delete')) {
      var r0 = (res.results || [])[0] || {};
      if (r0.outcome === 'skipped' || r0.outcome === 'failed') return r0.reason || 'Nothing was changed.';
      if (r0.outcome === 'merged') {
        var mv = Object.keys(r0.moved || {}).map(function (k) { return k + ' ' + r0.moved[k]; });
        var kp = Object.keys(r0.kept || {}).map(function (k) { return k + ' ' + r0.kept[k]; });
        return 'Merged “' + (r0.loser && r0.loser.label) + '” into “' + (r0.survivor && r0.survivor.label) + '”. Moved: ' + (mv.length ? mv.join(', ') : 'nothing attached') + '.' +
          (kp.length ? ' Stayed on the archived copy (the kept record already had its own): ' + kp.join(', ') + '.' : '') + ' The emptied copy is in the Archive tab.';
      }
      if (r0.outcome === 'archived') return 'Archived “' + (r0.record && r0.record.label) + '”. It is in the Archive tab.';
      if (r0.outcome === 'restored') return 'Restored “' + (r0.record && r0.record.label) + '”.' + (r0.note ? ' ' + r0.note : '');
      if (r0.outcome === 'deleted') return 'Permanently deleted “' + (r0.record && r0.record.label) + '”.';
    }
    var parts = res && res.mode === 'create' ? [(c.created || 0) + ' created in P86'] : res && res.mode === 'link' ? [(c.linked || 0) + ' linked'] : [(c.applied || 0) + ' updated'];
    var createNotes = []; ((res && res.results) || []).forEach(function (x) { (x.notes || []).forEach(function (n) { if (createNotes.indexOf(n) === -1) createNotes.push(n); }); });
    if (c.linked) parts.push(c.linked + ' newly linked');
    if (c.subAccess) parts.push('sub portal access granted on ' + c.subAccess);
    if (c.statusWord) parts.push('Buildertrend’s own word recorded on ' + c.statusWord);
    if (c.approvalKind) parts.push('which Buildertrend approval recorded on ' + c.approvalKind);
    if (c.fields) parts.push(c.fields + ' field' + (c.fields === 1 ? '' : 's') + ' changed');
    if (c.unchanged) parts.push(c.unchanged + ' already up to date');
    if (c.skipped) parts.push(c.skipped + ' skipped');
    var stale = []; ((res && res.results) || []).forEach(function (x) { (x.stale || []).forEach(function (f) { stale.push(f); }); });
    if (stale.length) parts.push('not applied because P86 changed since the preview or it would clash: ' + stale.slice(0, 5).join(', '));
    if (c.failed) parts.push(c.failed + ' failed');
    var reasons = ((res && res.results) || []).filter(function (x) { return x.outcome === 'skipped' || x.outcome === 'failed'; })
      .slice(0, 3).map(function (x) { return (x.label ? '“' + x.label + '”: ' : '') + x.reason; });
    return parts.join(' · ') + '.' + (reasons.length ? ' ' + reasons.join(' ') : '') + (createNotes.length ? ' ' + createNotes.slice(0, 3).join(' ') : '');
  }

  function runApply(key, body) {
    if (_applying || !(window.p86Api && typeof window.p86Api.put === 'function')) return;
    _applying = key + ':' + (body.mode === 'safe' ? 'safe' : body.mode === 'create' ? 'create:' + ((body.btIds && body.btIds[0]) || 'bulk') : (body.btIds && body.btIds[0]) || body.mode);
    if (body.btIds && body.btIds[0] && body.mode !== 'safe' && body.mode !== 'create') delete _picks[key + ':' + body.btIds[0]];
    _applyNote[key] = null;
    repaint(key);
    window.p86Api.put(APPLY_ENDPOINT, Object.assign({ dataset: key }, body)).then(function (res) {
      _applying = null;
      var okText = applyResultText(res);
      var bad = res && res.results && res.results[0] && (res.results[0].outcome === 'skipped' || res.results[0].outcome === 'failed') && ['merge', 'archive', 'restore', 'delete'].indexOf(res.mode) !== -1;
      _applyNote[key] = { ok: !bad, text: okText };
      if (['merge', 'archive', 'restore', 'delete'].indexOf(body.mode) !== -1) { _archiveNote = _applyNote[key]; _archive = null; loadArchive(); }
      (res && res.results || []).forEach(function (x) { if (x.btId) delete _picks[key + ':' + x.btId]; });
      load({ keepMarker: true });
    }).catch(function (e) {
      _applying = null;
      var msg = e && e.data && typeof e.data.error === 'string' ? e.data.error : 'The apply request failed' + (e && e.status ? ' (HTTP ' + e.status + ')' : '') + '.';
      _applyNote[key] = { ok: false, text: msg };
      repaint(key);
    });
  }

  // `danger` is a 4th parameter, not a new function: every existing call site
  // passes three arguments, so it arrives undefined -> false and nothing about
  // those dialogs changes.
  // What pressing Apply on ONE row has to say first, or null when it may just
  // go. Closing takes precedence over the money sentence and says the word
  // PERMANENT; 'close' is excluded from the money set so it can never be named
  // in both. Lifted out of the click handler so it can be read back in a test.
  function rowConfirm(key, row, fields) {
    var picked = fields || [];
    var money = (row ? (row.corrections || []).concat(row.heldBack || []) : []).filter(function (x) {
      return picked.indexOf(x.field) !== -1 && x.field !== 'close' && (x.money || x.reason === 'money' || x.field === 'jobNumber');
    });
    var moneyList = money.map(function (x) { return (x.label || x.field) + ' → ' + (x.to || x.bt); }).join(', ');
    if (picked.indexOf('close') !== -1) {
      return { danger: true, label: 'Close it permanently',
        message: 'Close this purchase order in Project 86? This is PERMANENT — a closed purchase order cannot be edited, unlocked, revised by addendum or deleted, by anyone, and it drops off the Purchase orders hub’s open list.'
          + (money.length
            ? ' The same press FIRST applies ' + moneyList + ', and that figure is then frozen for ever. Its sub keeps portal access.'
            : ' Its cost does not change and its sub keeps portal access.') };
    }
    if (money.length) {
      return { danger: false, label: 'Apply',
        message: 'Apply ' + moneyList + ' to this ' + (NOUN[key] || 'record') + '?' };
    }
    return null;
  }

  function askThen(message, label, fn, danger) {
    if (typeof window.p86Confirm === 'function') {
      Promise.resolve(window.p86Confirm({ title: 'Apply Buildertrend updates', message: message, confirmLabel: label, confirmText: label,
        cancelLabel: 'Cancel', cancelText: 'Cancel', danger: !!danger, destructive: !!danger })).then(function (ok) { if (ok) fn(); });
    } else if (window.confirm(message)) {
      fn();
    }
  }

  function loadArchive() {
    if (!(window.p86Api && typeof window.p86Api.get === 'function')) return;
    window.p86Api.get(ARCHIVE_ENDPOINT).then(function (d) {
      _archive = (d && Array.isArray(d.archive)) ? d.archive : [];
      _archiveErr = null;
      if (_tab === 'archive') paint();
    }).catch(function (e) {
      _archive = [];
      _archiveErr = errorSentence(e);
      if (_tab === 'archive') paint();
    });
  }

  function archiveHTML() {
    var html = '<section class="btp-ds" data-btp-ds="archive"><div class="btp-ds-head"><div class="btp-ds-title">Reconcile archive</div>' +
      '<div class="btp-sub">Merged duplicates and P86-only records set aside for review</div></div>';
    html += '<div class="btp-sentence is-ok">Restore puts a record back where it was (anything merged into another record stays there). Delete permanently is allowed only once nothing is attached to the record.</div>';
    if (_archiveNote) html += '<div class="btp-sentence ' + (_archiveNote.ok ? 'is-ok' : 'is-bad') + '">' + esc(_archiveNote.text) + '</div>';
    if (_archiveErr) html += '<div class="btp-sentence is-bad">' + esc(_archiveErr) + '</div>';
    if (_archive == null) { loadArchive(); return html + '<div class="btp-sub" style="padding:12px 0;">Loading the archive…</div></section>'; }
    if (!_archive.length) return html + '<div class="btp-sub" style="padding:12px 0;">Nothing is archived.</div></section>';
    html += _archive.map(function (a) {
      var why = a.reason === 'merged' ? 'Merged into ' + (a.mergedInto ? '“' + esc(a.mergedInto.label) + '”' : 'another record') : 'Not in Buildertrend';
      var att = Object.keys(a.attached || {});
      return '<div class="btp-row"><div class="btp-row-head"><span class="btp-chip c-notinbt">' + esc(NOUN[a.kind] || a.kind) + '</span>' +
        '<span class="btp-rung">' + why + (a.archivedAt ? ' · ' + esc(new Date(a.archivedAt).toLocaleString()) : '') + '</span>' +
        '<button type="button" class="btp-btn btp-apply" data-btp-restore="' + esc(a.id) + '" data-btp-kind="' + esc(a.kind) + '"' + (_applying ? ' disabled' : '') + '>Restore</button>' +
        '<button type="button" class="btp-btn" style="margin-left:6px;" data-btp-delete="' + esc(a.id) + '" data-btp-kind="' + esc(a.kind) + '" data-btp-delete-label="' + esc(a.label) + '"' + (_applying || !a.deletable ? ' disabled' : '') + '>Delete permanently</button></div>' +
        '<div class="btp-name">' + esc(a.label) + '</div>' +
        (att.length ? '<div class="btp-notes">Still attached (blocks a permanent delete): ' + att.map(function (k) { return esc(k) + ' ' + esc(a.attached[k]); }).join(', ') + '</div>' : '') + '</div>';
    }).join('');
    return html + '</section>';
  }

  function notInBtRowHTML(ds, p) {
    var meta = [];
    if (p.status) meta.push(esc(p.status));
    if (ds.key === 'clients' && p.state86 === 'property') meta.push('property under a parent client in P86');
    if (p.email) meta.push(esc(p.email));
    if (p.client) meta.push('Client: ' + esc(p.client));
    if (p.jobLabel) meta.push('on ' + esc(p.jobLabel));
    if (p.linkedGone) {
      meta.push(ds.key === 'leads'
        ? 'no longer an open lead in Buildertrend (sold, lost or closed there)'
        : 'linked to a Buildertrend ' + (NOUN[ds.key] || 'record') + ' that is no longer in Buildertrend');
    }
    var a = addr(p);
    if (a) meta.push(esc(a));
    var archiveBtn = DETAIL_KINDS[ds.key] ? ''
      : ds.key === 'leads'
      ? '<span class="btp-rung" style="margin-left:auto;">not archived: Buildertrend sends open leads only</span>'
      : '<button type="button" class="btp-btn btp-apply" data-btp-archive="' + esc(p.id) + '" data-btp-archive-label="' + esc(p.title || p.id) + '"' + (_applying ? ' disabled' : '') + '>Archive</button>';
    return '<div class="btp-row"><div class="btp-row-head"><span class="btp-chip c-notinbt">' + esc(CHIP.notinbt) + '</span>' +
      '<span class="btp-rung">' + (DETAIL_KINDS[ds.key] ? 'review only — change it in P86 if Buildertrend is right' : 'review only — archiving sets it aside, restorable') + '</span>' + archiveBtn + '</div>' +
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
      html += sinceHTML(ds);
      var cc = countsFor(ds, ui);
      var nib = ds.notInBuildertrend || {};
      var sc = safeCount(ds);
      var busySafe = _applying === ds.key + ':safe';
      html += '<div class="btp-filters"><button type="button" class="btp-btn btp-apply" data-btp-apply-safe="1"' + (_applying || !sc || !f.complete ? ' disabled' : '') + '>' +
        (busySafe ? 'Applying…' : (ds.key === 'jobs' ? 'Link confident matches + fill blank start dates' : ds.key === 'purchaseOrders' ? 'Link confident matches + give subs portal access' : 'Link confident matches') + ' (' + sc + ')') + '</button>' +
        '<span class="btp-sub">' + (f.complete ? safeSubText(ds) : 'Needs a complete Buildertrend read.') + '</span></div>';
      var cn = createCount(ds);
      var busyCreate = _applying === ds.key + ':create:bulk';
      html += '<div class="btp-filters"><button type="button" class="btp-btn btp-apply" data-btp-create-all="1"' + (_applying || !cn || !f.complete ? ' disabled' : '') + '>' +
        (busyCreate ? 'Creating…' : 'Create ' + cn + ' Buildertrend-only ' + (ds.key === 'jobs' ? 'open + warranty job' : (NOUN[ds.key] || 'record')) + (cn === 1 ? '' : 's') + ' in P86') + '</button>' +
        '<span class="btp-sub">' + (ds.key === 'jobs' ? 'Closed jobs are created one at a time from their row. ' : '') +
        (ds.key === 'clients' ? 'Create clients first — leads and jobs link to a client through its Buildertrend id. ' : '') +
        (ds.key === 'changeOrders' ? 'Each is created on its linked P86 job with Buildertrend’s price and cost as one line, and approved and locked when Buildertrend approved it. A change order whose job is not linked yet waits. ' : '') +
        (ds.key === 'purchaseOrders' ? 'Each is created on its linked P86 job with Buildertrend’s number, status, cost and sub/vendor (when it is exactly one P86 sub). A sent or approved one is committed and locked, so its cost accrues. No bill is created. A sent or approved PO’s sub gets portal access to the job’s files, as on the PO page. ' : '') +
        (ds.key === 'estimates' ? 'Each Buildertrend WORKSHEET becomes one real P86 estimate on its linked job, carrying that worksheet’s line items in Buildertrend’s own groups, and is born unsent, unlocked and not approved. A worksheet whose job is not linked yet waits, and one carrying a line Project 86 cannot price at Buildertrend’s own owner price is refused whole rather than imported at a number that is not Buildertrend’s. ' : '') +
        (ds.key === 'bills' ? 'Each is created on its linked P86 job at Buildertrend’s amount, with its vendor invoice number, dates and vendor, and its purchase order only where P86 has already imported that exact Buildertrend PO. Deleted and duplicated Buildertrend bills are never created. ' : '') +
        (ds.key === 'tasks' ? 'NO MONEY IS INVOLVED HERE — a task carries no cost, no price and no contract. Each becomes an ORG task on its linked P86 job (visible to the whole team, never a private To-do and never a work-order building), with Buildertrend’s title, notes and due date, done where Buildertrend has it done, and assigned only where the Buildertrend name is exactly one P86 user — otherwise UNASSIGNED rather than guessed. A task whose job is not linked yet waits. ' : '') +
        'Possible duplicates and ambiguous rows are never created.</span></div>';
      var note = _applyNote[ds.key];
      if (note) html += '<div class="btp-sentence ' + (note.ok ? 'is-ok' : 'is-bad') + '">' + esc(note.text) + '</div>';
      if (ds.key === 'jobs') {
        html += '<div class="btp-filters"><div class="btp-seg" role="group" aria-label="Buildertrend job scope">' +
          [['open', 'Open + Warranty'], ['all', 'All jobs']].map(function (s) {
            return '<button type="button" data-btp-scope="' + s[0] + '" class="' + (ui.scope === s[0] ? 'is-active' : '') + '">' + s[1] + '</button>';
          }).join('') + '</div><span class="btp-sub">Scope is Buildertrend’s status. Closed Buildertrend jobs appear here when their P86 status no longer matches. “Not in Buildertrend” is always checked against every job read.</span></div>';
      }
      html += '<div class="btp-tiles">';
      if (sinceCompared(ds)) {
        html += tile('since_new', cc.counts.since_new, esc(LABEL.since_new), 'in Buildertrend', ui.f === 'since_new');
        html += tile('since_changed', cc.counts.since_changed, esc(LABEL.since_changed), 'in Buildertrend', ui.f === 'since_changed');
      }
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
      if (cc.counts.refused) html += tile('refused', cc.counts.refused, esc(labelFor(ds, 'refused')), DETAIL_KINDS[ds.key] ? 'link its job first' : 'never created', ui.f === 'refused');
      if (cc.counts.typo) html += tile('typo', cc.counts.typo, 'Probable BT typos', 'fix in Buildertrend', ui.f === 'typo');
      html += tile('rate', cc.rate == null ? '—' : Math.round(cc.rate * 100) + '%', 'Match rate', 'of ' + esc(cc.base), false, true);
      html += '</div>';

      var sinceOpts = sinceCompared(ds) ? ['since_new', 'since_changed'] : [];
      var opts = ['all'].concat(sinceOpts).concat(['conflict', 'ambiguous', 'possible_duplicate', 'new', 'matched']).concat(ds.key === 'jobs' ? ['change_order', 'not_a_job'] : [])
        .concat(['refused', 'heldback', 'btblank', 'flagged', 'notinbt']);
      html += '<div class="btp-filters"><select class="btp-search" style="flex:0 1 auto;" data-btp-fselect="1" aria-label="Show">' +
        opts.map(function (k) {
          return '<option value="' + k + '"' + (ui.f === k ? ' selected' : '') + '>' + (k === 'all' ? 'All Buildertrend records' : esc(labelFor(ds, k))) + '</option>';
        }).join('') +
        // A filter the list above does not carry — an Overview target, a typo
        // sweep, or "new since" on a dataset that could not be compared — is
        // still the SELECTED option, or the box would name a view these rows
        // are not in.
        (opts.indexOf(ui.f) === -1 ? '<option value="' + esc(ui.f) + '" selected>' + esc(filterName(ds, ui)) + '</option>' : '') + '</select>' +
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

  // ══════════════════════════════════════════════════════════════════════
  // THE OVERVIEW TAB — "what do I do next, and in what order"
  // ══════════════════════════════════════════════════════════════════════
  //
  // Built ENTIRELY out of the response the seven tabs already render. It adds
  // no request, no route and no server field: every figure below is walked out
  // of _data.datasets. It is a TAB rather than a page because the one thing it
  // must do — take a person to exactly the rows it counted — is setting another
  // tab's filter, and because the preview is one slow single-flight GET that a
  // second page would have to build again.
  //
  // THE ONE RULE THAT KEEPS IT HONEST. A number is shown next to a click only
  // when that number IS the length of the list the click lands on. Every
  // counted link is a TARGET — { key, f, scope, q, waitJob } — and its count
  // comes from countTarget(), which runs the SAME visibleRows() the destination
  // tab runs, under the same scope rule. A group's count is the sum of its
  // parts' counts and nothing else, so a group can never claim more than its
  // clicks reach. The dependency chain is the one place a second arithmetic
  // exists (rows grouped by the Buildertrend job they wait on), and the tests
  // hold the two against each other.

  var DS_ORDER = ['jobs', 'leads', 'clients', 'changeOrders', 'purchaseOrders', 'bills', 'estimates', 'tasks'];
  // The datasets whose rows can be BLOCKED: a change order, purchase order,
  // bill, estimate worksheet or task whose Buildertrend job is not linked to a
  // P86 job is refused with waitingOnJob and can do nothing until that job
  // exists in P86 and carries the Buildertrend id. Tasks span 64 Buildertrend
  // jobs, so leaving them out here would drop the largest contributor to the
  // chain's ranking while the Tasks tab still showed the rows.
  var WAIT_KINDS = ['changeOrders', 'purchaseOrders', 'bills', 'estimates', 'tasks'];

  function dsOf(key) {
    return (_data && _data.datasets && _data.datasets[key]) || null;
  }

  function dsLabel(key) {
    var ds = dsOf(key);
    return (ds && ds.label) || key;
  }

  // A target's view, built fresh so counting never touches the real _ui.
  function targetUi(t) {
    return { f: t.f, scope: t.scope || 'all', q: t.q || '', waitJob: t.waitJob || '', shown: PAGE };
  }

  function countTarget(t) {
    var ds = dsOf(t.key);
    if (!ds || !ds.classified) return 0;
    return visibleRows(ds, targetUi(t)).length;
  }

  // The click. It puts the destination tab into exactly the view countTarget()
  // measured, so what lands on screen is the list whose length was printed.
  function navigate(t) {
    var ui = _ui[t.key];
    if (!ui) return;
    ui.f = t.f;
    ui.scope = t.scope || 'all';
    ui.q = t.q || '';
    ui.waitJob = t.waitJob || '';
    ui.waitJobLabel = t.waitJobLabel || '';
    ui.shown = PAGE;
    _tab = t.key;
    try { if (window.localStorage) window.localStorage.setItem('btp.tab', _tab); } catch (e) { /* storage blocked */ }
    paint();
  }

  // ── THE DEPENDENCY CHAIN ───────────────────────────────────────────────
  //
  // Which Buildertrend job is each waiting row waiting on? Its own id when it
  // has one, and its name when it does not — the two keys the matchers
  // themselves use. A row carrying neither lands in one bucket of its own,
  // which is reachable like any other (waitJob '').
  function waitKey(r) {
    var b = r && r.bt;
    var id = b && b.jobId != null ? String(b.jobId).trim() : '';
    if (id) return 'id:' + id;
    var n = b && b.jobName != null ? String(b.jobName).trim().toLowerCase().replace(/\s+/g, ' ') : '';
    return n ? 'name:' + n : '';
  }

  // The Jobs row for a blocking Buildertrend job: by Buildertrend id, then by
  // the job name exactly as Buildertrend wrote it on both records.
  function jobRowFor(b) {
    var jobs = dsOf('jobs');
    if (!jobs || !jobs.classified) return null;
    var rows = jobs.rows || [];
    var i;
    var bt;
    if (b.jobId) {
      for (i = 0; i < rows.length; i++) {
        bt = rows[i].bt;
        if (bt && bt.btId != null && String(bt.btId).trim() === b.jobId) return rows[i];
      }
    }
    if (b.jobName) {
      var want = b.jobName.toLowerCase().replace(/\s+/g, ' ');
      for (i = 0; i < rows.length; i++) {
        bt = rows[i].bt;
        var raw = bt && bt.raw != null ? String(bt.raw).trim().toLowerCase().replace(/\s+/g, ' ') : '';
        if (raw && raw === want) return rows[i];
      }
    }
    return null;
  }

  // What has to happen to that job before anything behind it can move. The
  // order is the order of effort: a link is one press for all of them, a create
  // is one press for the open ones, and a decision is a person per job.
  var ACTIONS = {
    link: { order: 0, label: 'Link it', verb: 'Linking',
      why: 'P86 already holds this job and the match is confident. “Link confident matches” on the Jobs tab links every one of them in one press.' },
    create: { order: 1, label: 'Create it', verb: 'Creating',
      why: 'Nothing in P86 matches it. Creating it from the Jobs tab links it by Buildertrend id at the same time.' },
    decide: { order: 2, label: 'Decide which job', verb: 'Deciding on',
      why: 'More than one P86 job could be this one, so nothing is proposed until a person picks it on the Jobs tab.' },
    stuck: { order: 3, label: 'Not a job in P86', verb: 'Sorting out',
      why: 'The Jobs tab could not treat this Buildertrend job as a job — no job number, a change-order row, or refused. Fix it in Buildertrend.' },
    linked: { order: 4, label: 'Already linked — refresh', verb: 'Refreshing',
      why: 'The Jobs tab has this one linked by Buildertrend id already, so this read is older than that link. Press Refresh.' },
    missing: { order: 5, label: 'Not in the Jobs read', verb: 'Reading',
      why: 'No Buildertrend job in this read carries that id or name — the Jobs read may be partial, or the job may have been deleted there.' },
    unnamed: { order: 6, label: 'No job on the record', verb: 'Chasing',
      why: 'These records reached Project 86 naming no Buildertrend job at all, by id or by name. Nothing here can find their job — fix them in Buildertrend.' }
  };

  var ACTION_ORDER = ['link', 'create', 'decide', 'stuck', 'linked', 'missing', 'unnamed'];

  function blockerAction(b, row) {
    if (!b.jobId && !b.jobName) return 'unnamed';
    if (!row) return 'missing';
    var c = row['class'];
    if (c === 'new') return 'create';
    if (c === 'matched' || c === 'conflict') return row.rung === 'Buildertrend ID' ? 'linked' : 'link';
    if (c === 'ambiguous' || c === 'possible_duplicate') return 'decide';
    return 'stuck';
  }

  // Every waiting row, grouped by the Buildertrend job it waits on, ranked by
  // how much that one job unblocks. This is the arithmetic the page leads with.
  function blockers() {
    var byKey = {};
    var order = [];
    WAIT_KINDS.forEach(function (key) {
      var ds = dsOf(key);
      if (!ds || !ds.classified) return;
      (ds.rows || []).forEach(function (r) {
        if (r.waitingOnJob !== true) return;
        var k = waitKey(r);
        if (!byKey[k]) {
          byKey[k] = { key: k, jobId: k.indexOf('id:') === 0 ? k.slice(3) : '', jobName: '', counts: {}, total: 0 };
          WAIT_KINDS.forEach(function (x) { byKey[k].counts[x] = 0; });
          order.push(k);
        }
        var b = byKey[k];
        if (!b.jobName && r.bt && r.bt.jobName) b.jobName = String(r.bt.jobName).trim();
        b.counts[key]++;
        b.total++;
      });
    });
    var list = order.map(function (k) { return byKey[k]; });
    list.forEach(function (b) {
      b.jobRow = jobRowFor(b);
      b.action = blockerAction(b, b.jobRow);
    });
    list.sort(function (a, b) {
      if (b.total !== a.total) return b.total - a.total;
      var ao = ACTIONS[a.action].order;
      var bo = ACTIONS[b.action].order;
      if (ao !== bo) return ao - bo;
      var an = a.jobName || a.key;
      var bn = b.jobName || b.key;
      return an < bn ? -1 : an > bn ? 1 : 0;
    });
    return list;
  }

  // Jobs and blocked records per action, so the page can say "linking these N
  // jobs unblocks this much" instead of listing 60 rows and hoping.
  function blockerSummary(list) {
    var by = {};
    (list || []).forEach(function (b) {
      if (!by[b.action]) by[b.action] = { jobs: 0, blocked: 0 };
      by[b.action].jobs++;
      by[b.action].blocked += b.total;
    });
    return by;
  }

  // ── MONEY ──────────────────────────────────────────────────────────────
  //
  // Every money figure on this page comes back out of the text the server
  // already formatted (fmtMoney: "$1,234.56", "-$1,234.56"). A range, a word or
  // anything else reads as no figure at all and is counted apart rather than
  // guessed at.
  function moneyNum(text) {
    if (text == null) return null;
    var s = String(text).trim();
    if (!s) return null;
    var neg = s.charAt(0) === '-';
    if (neg) s = s.slice(1);
    if (s.charAt(0) !== '$') return null;
    s = s.slice(1).replace(/,/g, '');
    if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
    var n = Number(s);
    if (!isFinite(n)) return null;
    return neg ? -n : n;
  }

  function num(v) {
    return typeof v === 'number' && isFinite(v);
  }

  function round2(n) {
    return Math.round(n * 100) / 100;
  }

  function fmtUSD(n) {
    if (!num(n)) return '';
    var neg = n < 0;
    return (neg ? '-$' : '$') + Math.abs(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  // A held-back item that is about money. `money: true` is how most of them are
  // marked; a few carry only `reason: 'money'` (the purchase-order addendum is
  // the one that matters), so both count.
  function isMoneyItem(h) {
    return !!h && (h.money === true || h.reason === 'money');
  }

  // Money a person could tick on this row. NOT-APPLICABLE items are never
  // counted: P86 has the bill paid, the change order applied, the purchase
  // order closed — a sync does not move them and nothing is waiting on a press.
  function isTickableMoney(h) {
    return isMoneyItem(h) && h.applicable === true;
  }

  function hasTickableMoney(r) {
    return (r.heldBack || []).some(isTickableMoney);
  }

  // What one press of "Create …" on a dataset would create, exactly. createCount()
  // is this rule, so the dashboard's count and the button's count are one thing.
  function isCreatable(ds, r) {
    return r['class'] === 'new' && !r.createBlocked && r.bt && r.bt.btId != null && r.bt.btId !== ''
      && (ds.key !== 'jobs' || r.bt.scope === 'open');
  }

  function creatableRows(key) {
    var ds = dsOf(key);
    if (!ds || !ds.classified) return [];
    return (ds.rows || []).filter(function (r) { return isCreatable(ds, r); });
  }

  function sumText(rows, read) {
    var out = { n: rows.length, total: 0, unreadable: 0 };
    rows.forEach(function (r) {
      var v = moneyNum(read(r));
      if (v == null) out.unreadable++;
      else out.total += v;
    });
    out.total = round2(out.total);
    return out;
  }

  function moneyAtStake() {
    var tick = { items: 0, rows: 0, bt: 0, p86: 0, noFigure: 0 };
    var review = { items: 0, rows: 0 };
    DS_ORDER.forEach(function (key) {
      var ds = dsOf(key);
      if (!ds || !ds.classified) return;
      (ds.rows || []).forEach(function (r) {
        var t = 0;
        var v = 0;
        (r.heldBack || []).forEach(function (h) {
          if (!isMoneyItem(h)) return;
          if (isTickableMoney(h)) {
            tick.items++;
            t++;
            // A single figure on both sides can be totalled. An item whose
            // value is a whole set of line items cannot, and is counted apart
            // rather than folded into a dollar sum nobody could check.
            if (num(h.value) && num(h.p86Value)) { tick.bt += h.value; tick.p86 += h.p86Value; }
            else tick.noFigure++;
          } else {
            review.items++;
            v++;
          }
        });
        if (t) tick.rows++;
        if (v) review.rows++;
      });
    });
    tick.bt = round2(tick.bt);
    tick.p86 = round2(tick.p86);
    tick.delta = round2(tick.bt - tick.p86);

    var po = dsOf('purchaseOrders');
    var poRows = creatableRows('purchaseOrders');
    var committed = sumText(poRows.filter(function (r) { return r.bt && r.bt.state86 && r.bt.state86 !== 'draft'; }),
      function (r) { return r.bt.costText; });
    var draft = sumText(poRows.filter(function (r) { return !(r.bt && r.bt.state86 && r.bt.state86 !== 'draft'); }),
      function (r) { return r.bt.costText; });
    var bills = sumText(creatableRows('bills'), function (r) { return r.bt.amountText; });
    var estimates = sumText(creatableRows('estimates'), function (r) { return r.bt.ownerText; });
    return { tick: tick, review: review, committed: committed, draft: draft, bills: bills, estimates: estimates,
      poRead: !!(po && po.classified) };
  }

  // ── SYNC HEALTH ────────────────────────────────────────────────────────
  //
  // A DECLARED KEY NO RECORD CARRIES IS A DEFECT, not a note: it has shipped
  // twice ('item' on estimates, and a whole dataset refusing on a markup type
  // nobody could see), and both times the diagnostic held the answer while the
  // page said nothing. Keys the records carry that P86 does not read are
  // information about Buildertrend, not a fault here, and read that way.
  function health() {
    return DS_ORDER.map(function (key) {
      var ds = dsOf(key);
      if (!ds) {
        return { key: key, label: key, absent: true, read: 'failed', defect: false,
          missingKeys: [], unexpectedKeys: [], error: 'This server did not send a ' + key + ' comparison.' };
      }
      var f = ds.fetch || {};
      var m = ds.mapping;
      // A dataset whose FETCH failed never reached describeMapping, so a null
      // mapping beside an error is the fetch failing — not a silent mapping.
      var failed = !!(ds.error && !m);
      return {
        key: key,
        label: ds.label || key,
        read: failed ? 'failed' : (f.complete === true ? 'complete' : 'partial'),
        fetched: f.fetched == null ? 0 : f.fetched,
        reported: f.reportedCount == null ? null : f.reportedCount,
        elapsedMs: f.elapsedMs == null ? null : f.elapsedMs,
        reason: f.reason || null,
        classified: ds.classified === true,
        error: ds.error ? ds.error.message : null,
        refusal: m && m.refusal ? m.refusal : null,
        missingKeys: (m && m.missingKeys) || [],
        unexpectedKeys: (m && m.unexpectedKeys) || [],
        defect: !!((m && m.refusal) || (m && m.missingKeys && m.missingKeys.length))
      };
    });
  }

  // ── THE WORK QUEUES ────────────────────────────────────────────────────
  //
  // Grouped by what a PERSON DOES, across all seven datasets at once, because
  // "create these" is one job whether the thing is a job, a bill or a
  // worksheet. Each part is one click into one dataset's filtered list.
  function partDefs(f, note) {
    return DS_ORDER.map(function (k) { return { key: k, f: f, note: note }; });
  }

  function groupDefs() {
    return [
      { id: 'blocked', tone: 'refused', title: 'Blocked behind a job that is not linked',
        why: 'Nothing can be created or corrected on these until their Buildertrend job is a P86 job carrying the Buildertrend id. The chain above says which jobs, and in which order.',
        parts: WAIT_KINDS.map(function (k) { return { key: k, f: 'waiting' }; }) },
      { id: 'create', tone: 'new', title: 'Would be created in Project 86',
        why: 'Buildertrend holds these and P86 does not. Each count is exactly what that tab’s one Create press makes — ambiguous rows and possible duplicates are never created.',
        parts: partDefs('creatable').concat([{ key: 'jobs', f: 'closed_new', note: 'closed in Buildertrend — created one at a time from the row' }]) },
      { id: 'disagree', tone: 'conflict', title: 'Fields that disagree',
        why: 'P86 holds these already and Buildertrend says something different. Money and job numbers are never in that press — they wait for a tick below.',
        parts: partDefs('conflict') },
      { id: 'money', tone: 'heldback', title: 'Money waiting for a tick',
        why: 'A figure a sync will never move on its own. Each of these rows carries at least one money item a person may tick on purpose.',
        parts: partDefs('money') },
      { id: 'undecided', tone: 'ambiguous', title: 'Cannot be told apart',
        why: 'Two or more P86 records could be the Buildertrend one, or one looks like it without matching. Nothing is proposed and nothing is created until a person picks.',
        parts: partDefs('ambiguous', 'ambiguous').concat(partDefs('possible_duplicate', 'possible duplicate')) },
      { id: 'refused', tone: 'notinbt', title: 'Refused — nothing can be proposed',
        why: 'Deleted in Buildertrend, sent without an id or a name, or carrying something P86 cannot hold. Rows waiting on a job are counted in their own group above, not here.',
        parts: partDefs('refused_only') }
    ];
  }

  function groups() {
    return groupDefs().map(function (g) {
      var parts = g.parts.map(function (p) {
        return { key: p.key, f: p.f, scope: 'all', note: p.note || '', label: dsLabel(p.key), n: countTarget(p) };
      }).filter(function (p) { return p.n > 0; });
      // THE GROUP'S COUNT IS THE SUM OF ITS PARTS AND NOTHING ELSE.
      g.parts = parts;
      g.n = parts.reduce(function (s, p) { return s + p.n; }, 0);
      return g;
    });
  }

  // Why each refused row was refused — the matcher's own first sentence,
  // counted. Every row the "Refused" group reaches is in exactly one bucket, so
  // these add up to that group's count.
  function refusalReasons() {
    var by = {};
    var order = [];
    DS_ORDER.forEach(function (key) {
      var ds = dsOf(key);
      if (!ds || !ds.classified) return;
      (ds.rows || []).forEach(function (r) {
        if (r['class'] !== 'refused' || r.waitingOnJob === true) return;
        var why = (r.notes || [])[0] || 'No reason was given.';
        if (!by[why]) { by[why] = { why: why, n: 0 }; order.push(why); }
        by[why].n++;
      });
    });
    return order.map(function (w) { return by[w]; }).sort(function (a, b) {
      if (b.n !== a.n) return b.n - a.n;
      return a.why < b.why ? -1 : a.why > b.why ? 1 : 0;
    });
  }

  // ── RENDER ─────────────────────────────────────────────────────────────

  function goBtn(t, inner, cls) {
    return '<button type="button" class="' + cls + '" data-btp-go="' + esc(JSON.stringify(t)) + '">' + inner + '</button>';
  }

  function partBtn(p) {
    return goBtn({ key: p.key, f: p.f, scope: p.scope },
      '<span class="btp-part-n">' + esc(p.n) + '</span> ' + esc(p.label) + (p.note ? ' <span class="btp-part-s">' + esc(p.note) + '</span>' : ''),
      'btp-part');
  }

  // ── WHERE THE AUTOMATIC SYNC GOES ──────────────────────────────────────
  // An automatic sync that applies changes unattended — with an audit of every
  // automatic write and an undo — is a SEPARATE change and is NOT built here.
  // This block is the hole it drops into: the first thing on the Overview,
  // above everything a person presses by hand. When the runner ships,
  // runStatusHTML() renders its last run, what it wrote and its undo in place
  // of this sentence, reading its own field off the response. Nothing below
  // moves, because nothing below reads this block.
  function runStatusHTML() {
    return '<div class="btp-run" data-btp-run-slot="1"><b>Every change here is one you press.</b> ' +
      'No sync runs on its own yet, so nothing below is a record of an automatic write and there is nothing to undo. ' +
      'When an automatic sync arrives, its last run, what it changed and its undo appear in this block.</div>';
  }

  function depHTML() {
    var list = blockers();
    var sum = blockerSummary(list);
    var html = '<section class="btp-dash-sec" data-btp-dash="dependencies">' +
      '<div class="btp-dash-h">What one job unblocks</div>' +
      '<div class="btp-dash-w">A change order, purchase order, bill or estimate worksheet whose Buildertrend job is not linked to a P86 job can do nothing at all. ' +
      'These are those rows, grouped by the job they are waiting on and ranked by how much each job releases. Work down this list and everything below it gets smaller.</div>';
    if (!list.length) {
      return html + '<div class="btp-sentence is-ok" data-btp-dep-none="1">Nothing is waiting on a job.</div></section>';
    }
    var blockedTotal = list.reduce(function (s, b) { return s + b.total; }, 0);
    var lead = [];
    ACTION_ORDER.forEach(function (a) {
      var s = sum[a];
      if (!s) return;
      lead.push('<b>' + esc(ACTIONS[a].verb) + ' ' + esc(s.jobs) + ' job' + (s.jobs === 1 ? '' : 's') + '</b> unblocks ' +
        esc(s.blocked) + ' record' + (s.blocked === 1 ? '' : 's') + ' <span class="btp-meta">(' + esc(ACTIONS[a].label.toLowerCase()) + ')</span>');
    });
    var kinds = WAIT_KINDS.filter(function (k) {
      return list.some(function (b) { return b.counts[k] > 0; });
    }).length;
    html += '<div class="btp-lead" data-btp-dep-lead="1">' + esc(blockedTotal) + ' record' + (blockedTotal === 1 ? '' : 's') +
      ' across ' + esc(kinds) + ' dataset' + (kinds === 1 ? '' : 's') + ' ' + (blockedTotal === 1 ? 'is' : 'are') +
      ' waiting on ' + esc(list.length) + ' Buildertrend job' + (list.length === 1 ? '' : 's') + '. ' +
      lead.join('. ') + '.</div>';
    html += '<div class="btp-scroll"><table class="btp-dep"><thead><tr><th>Buildertrend job</th><th>What it needs</th>' +
      WAIT_KINDS.map(function (k) { return '<th class="btp-num">' + esc(dsLabel(k)) + '</th>'; }).join('') +
      '<th class="btp-num">Blocked</th></tr></thead><tbody>';
    html += list.map(function (b) {
      var act = ACTIONS[b.action];
      var name = b.jobName || (b.jobId ? 'Buildertrend job ' + b.jobId : '(no job named on these records)');
      var jobLink = b.jobName
        ? goBtn({ key: 'jobs', f: 'all', scope: 'all', q: b.jobName }, esc(name), 'btp-linkish')
        : esc(name);
      return '<tr data-btp-dep-row="' + esc(b.key) + '"><td>' + jobLink + '</td>' +
        '<td><span class="btp-act a-' + esc(b.action) + '">' + esc(act.label) + '</span></td>' +
        WAIT_KINDS.map(function (k) {
          var n = b.counts[k];
          if (!n) return '<td class="btp-num"><span class="btp-none">—</span></td>';
          return '<td class="btp-num">' + goBtn({ key: k, f: 'waitjob', scope: 'all', waitJob: b.key, waitJobLabel: name },
            esc(n), 'btp-linkish') + '</td>';
        }).join('') +
        '<td class="btp-num"><b>' + esc(b.total) + '</b></td></tr>';
    }).join('');
    html += '</tbody></table></div>';
    html += '<ul class="btp-list btp-dep-why">' + ACTION_ORDER.filter(function (a) { return sum[a]; })
      .map(function (a) { return '<li><b>' + esc(ACTIONS[a].label) + '</b> — ' + esc(ACTIONS[a].why) + '</li>'; }).join('') + '</ul>';
    return html + '</section>';
  }

  function groupsHTML() {
    var gs = groups();
    var html = '<section class="btp-dash-sec" data-btp-dash="groups">' +
      '<div class="btp-dash-h">What there is to do</div>' +
      '<div class="btp-dash-w">Every Buildertrend record in this read, grouped by what a person would do with it rather than by which tab it sits on. ' +
      'Each count is the length of the list its own button lands on.</div>';
    html += gs.map(function (g) {
      var body = g.parts.length
        ? '<div class="btp-parts">' + g.parts.map(partBtn).join('') + '</div>'
        : '<div class="btp-none">Nothing.</div>';
      var extra = '';
      if (g.id === 'money') extra = moneyLinesHTML();
      if (g.id === 'refused') {
        var rs = refusalReasons();
        if (rs.length) {
          extra = '<ul class="btp-list btp-why">' + rs.slice(0, 8).map(function (x) {
            return '<li><b>' + esc(x.n) + '</b> — ' + esc(x.why) + '</li>';
          }).join('') + (rs.length > 8 ? '<li class="btp-meta">and ' + esc(rs.length - 8) + ' more reasons</li>' : '') + '</ul>';
        }
      }
      return '<div class="btp-grp c-' + esc(g.tone) + '" data-btp-group="' + esc(g.id) + '">' +
        '<div class="btp-grp-h"><span class="btp-grp-n" data-btp-group-n="' + esc(g.id) + '">' + esc(g.n) + '</span>' +
        '<span class="btp-grp-t">' + esc(g.title) + '</span></div>' +
        '<div class="btp-grp-w">' + esc(g.why) + '</div>' + body + extra + '</div>';
    }).join('');
    return html + '</section>';
  }

  // The money sentence that belongs inside the "Money waiting for a tick"
  // group: what those ticks are worth, and what they are NOT.
  function moneyLinesHTML() {
    var m = moneyAtStake();
    var t = m.tick;
    var bits = [];
    if (t.items) {
      bits.push('<li>Buildertrend <b>' + esc(fmtUSD(t.bt)) + '</b> against Project 86’s <b>' + esc(fmtUSD(t.p86)) + '</b> on ' +
        esc(t.items - t.noFigure) + ' item' + (t.items - t.noFigure === 1 ? '' : 's') + ' that carry one figure on each side — a difference of <b>' +
        esc(fmtUSD(t.delta)) + '</b>. <span class="btp-meta">Proposed, not applied: nothing moves until the box is ticked and the press confirmed.</span></li>');
    }
    if (t.noFigure) {
      bits.push('<li><b>' + esc(t.noFigure) + '</b> more tickable item' + (t.noFigure === 1 ? ' is' : 's are') +
        ' a whole set of line items rather than one figure, so they are not in that total. <span class="btp-meta">Adding them to it would be adding two different things.</span></li>');
    }
    if (m.review.items) {
      bits.push('<li><b>' + esc(m.review.items) + '</b> money item' + (m.review.items === 1 ? '' : 's') +
        ' on ' + esc(m.review.rows) + ' row' + (m.review.rows === 1 ? '' : 's') + ' cannot be ticked at all — P86 has them settled, applied or closed. ' +
        '<span class="btp-meta">Shown for review, never applied, and never in a total on this page.</span></li>');
    }
    if (!bits.length) return '';
    return '<ul class="btp-list btp-why">' + bits.join('') + '</ul>';
  }

  function moneyCard(tone, n, label, sub) {
    return '<div class="btp-mcard c-' + tone + '"><div class="btp-mn">' + esc(n) + '</div>' +
      '<div class="btp-tile-l">' + esc(label) + '</div><div class="btp-tile-s">' + esc(sub) + '</div></div>';
  }

  function moneyHTML() {
    var m = moneyAtStake();
    var html = '<section class="btp-dash-sec" data-btp-dash="money">' +
      '<div class="btp-dash-h">Money at stake</div>' +
      '<div class="btp-dash-w">Every figure here is Buildertrend’s, and every one of them is PROPOSED. Nothing on this page has been applied to Project 86, ' +
      'and no two of these are added together — they are different kinds of money and a single total would mean nothing.</div>' +
      '<div class="btp-money">';
    html += moneyCard('heldback', fmtUSD(m.tick.delta) || '$0.00', 'Waiting for a tick',
      m.tick.items + ' held-back money item' + (m.tick.items === 1 ? '' : 's') + ' · Buildertrend ' + (fmtUSD(m.tick.bt) || '$0.00') + ' vs P86 ' + (fmtUSD(m.tick.p86) || '$0.00'));
    html += moneyCard('conflict', fmtUSD(m.committed.total) || '$0.00', 'Committed POs not in P86',
      m.committed.n + ' purchase order' + (m.committed.n === 1 ? '' : 's') + ' sent or approved in Buildertrend — creating them starts that cost on the job'
      + (m.committed.unreadable ? ' · ' + m.committed.unreadable + ' sent no readable cost' : ''));
    html += moneyCard('new', fmtUSD(m.draft.total) || '$0.00', 'Draft POs not in P86',
      m.draft.n + ' still a draft in Buildertrend — created uncommitted, so nothing accrues yet'
      + (m.draft.unreadable ? ' · ' + m.draft.unreadable + ' sent no readable cost' : ''));
    html += moneyCard('notinbt', fmtUSD(m.bills.total) || '$0.00', 'Bills not in P86',
      m.bills.n + ' bill' + (m.bills.n === 1 ? '' : 's') + ' — real money owed, which accrues on the job and counts toward its PO’s %-billed'
      + (m.bills.unreadable ? ' · ' + m.bills.unreadable + ' sent no readable amount' : ''));
    html += moneyCard('matched', fmtUSD(m.estimates.total) || '$0.00', 'Estimate worksheets not in P86',
      m.estimates.n + ' worksheet' + (m.estimates.n === 1 ? '' : 's') + ' at Buildertrend’s owner price — a proposal, born unsent and unapproved'
      + (m.estimates.unreadable ? ' · ' + m.estimates.unreadable + ' sent no readable price' : ''));
    return html + '</div></section>';
  }

  function healthHTML() {
    var rows = health();
    var partial = rows.filter(function (h) { return h.read === 'partial'; }).length;
    var failed = rows.filter(function (h) { return h.read === 'failed'; }).length;
    var defects = rows.filter(function (h) { return h.defect; }).length;
    var html = '<section class="btp-dash-sec" data-btp-dash="health">' +
      '<div class="btp-dash-h">Sync health</div>' +
      '<div class="btp-dash-w">What this read actually reached, and whether the fields it reads are the fields Buildertrend sends. ' +
      'A declared key no record carries is a DEFECT — nothing can ever be proposed from it, and it reads as absent rather than wrong. ' +
      'Keys the records carry that Project 86 does not read are information about Buildertrend, not a fault here.</div>';
    html += '<div class="btp-lead" data-btp-health-lead="1">' +
      (_data && _data.generatedAt ? 'Read ' + esc(new Date(_data.generatedAt).toLocaleString()) + ' in ' + esc(_data.elapsedMs) + ' ms. ' : '') +
      (failed ? '<b>' + esc(failed) + ' dataset' + (failed === 1 ? '' : 's') + ' failed.</b> ' : '') +
      (partial ? '<b>' + esc(partial) + ' read' + (partial === 1 ? '' : 's') + ' partial</b> — every count on this page covers only what was fetched. ' : '') +
      (defects ? '<b>' + esc(defects) + ' mapping defect' + (defects === 1 ? '' : 's') + '.</b>' : (failed || partial ? '' : 'Every dataset read completely and every declared key arrived.')) +
      '</div>';
    html += '<div class="btp-health">' + rows.map(function (h) {
      var tone = h.read === 'failed' ? 'refused' : h.read === 'partial' ? 'ambiguous' : 'matched';
      var badge = h.read === 'failed' ? 'Failed' : h.read === 'partial' ? 'Partial' : 'Complete';
      var s = '<div class="btp-hrow" data-btp-health="' + esc(h.key) + '">' +
        '<div class="btp-row-head"><span class="btp-hbadge c-' + tone + '" data-btp-health-read="' + esc(h.key) + '">' + esc(badge) + '</span>' +
        '<b>' + esc(h.label) + '</b>' +
        (h.absent ? '' : goBtn({ key: h.key, f: 'all', scope: 'all' }, 'Open', 'btp-btn btp-link')) + '</div>';
      s += '<div class="btp-meta">' + esc(h.fetched) + ' of ' + (h.reported == null ? '?' : esc(h.reported)) + ' fetched' +
        (h.elapsedMs == null ? '' : ' · ' + esc(h.elapsedMs) + ' ms') + '</div>';
      if (h.reason) s += '<div class="btp-notes">' + esc(h.reason) + '</div>';
      // A mapping refusal IS this dataset's error sentence, and it is printed
      // once, as the defect it is — not twice, as a note and a defect.
      if (h.error && h.error !== h.refusal) s += '<div class="btp-notes">' + esc(h.error) + '</div>';
      if (h.refusal) {
        s += '<div class="btp-fix-note is-typo" data-btp-health-defect="' + esc(h.key) + '">Mapping refused: ' + esc(h.refusal) + '</div>';
      } else if (h.missingKeys.length) {
        s += '<div class="btp-fix-note is-typo" data-btp-health-defect="' + esc(h.key) + '">Defect — declared key' +
          (h.missingKeys.length === 1 ? '' : 's') + ' no record carried: <b>' + h.missingKeys.map(esc).join(', ') + '</b>. ' +
          'Nothing can be proposed from ' + (h.missingKeys.length === 1 ? 'it' : 'them') + ', and ' +
          (h.missingKeys.length === 1 ? 'it reads' : 'they read') + ' as absent rather than wrong.</div>';
      } else if (h.classified) {
        s += '<div class="btp-fix-note">Every declared key arrived.</div>';
      }
      if (h.unexpectedKeys.length) {
        s += '<div class="btp-notes" data-btp-health-extra="' + esc(h.key) + '">' + esc(h.unexpectedKeys.length) +
          ' key' + (h.unexpectedKeys.length === 1 ? '' : 's') + ' arrived that P86 does not read — information, not a fault: <span class="btp-code">' +
          h.unexpectedKeys.slice(0, 6).map(function (k) { return esc(k.key); }).join(' · ') + '</span></div>';
      }
      return s + '</div>';
    }).join('') + '</div>';
    return html + '</section>';
  }

  function dashboardHTML() {
    return runStatusHTML() + depHTML() + groupsHTML() + moneyHTML() + healthHTML();
  }

  function pageHTML() {
    var html = '<div class="btp">';
    html += '<div class="btp-banner" role="note"><div><b>Nothing changes until you press Apply</b> — and nothing is ever written to Buildertrend.</div>' +
      '<p>Buildertrend is the source of truth, so each difference is shown as the correction Project 86 would receive. ' +
      'A blank in Buildertrend never overwrites a P86 value. Money and job numbers change only when their box is ticked and you confirm. Ambiguous matches propose nothing and cannot be applied. A sync never deletes anything. ' +
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
        var fresh = d && d.rows && _ui[t[0]] ? sinceCount(d, _ui[t[0]]) : 0;
        return '<button type="button" role="tab" class="btp-tab' + (_tab === t[0] ? ' is-active' : '') + '" aria-selected="' + (_tab === t[0]) + '" data-btp-tab="' + t[0] + '">' +
          t[1] + (waiting ? ' <span class="btp-tab-n">' + waiting + '</span>' : '') +
          (fresh ? ' <span class="btp-tab-new" data-btp-tab-new="' + t[0] + '" title="New or changed in Buildertrend since your last refresh">' + fresh + ' new</span>' : '') + '</button>';
      }).join('') + '</div>';
      if (_tab === 'overview') html += dashboardHTML();
      else if (_tab === 'archive') html += archiveHTML();
      else if (_data.datasets && _data.datasets[_tab]) html += datasetHTML(_data.datasets[_tab]);
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
    if (r) r.addEventListener('click', function () { load(); });
    // Every counted button on the Overview carries its own target, and the
    // target is what countTarget() measured.
    Array.prototype.forEach.call(_host.querySelectorAll('[data-btp-go]'), function (b) {
      b.addEventListener('click', function () {
        var t;
        try { t = JSON.parse(b.getAttribute('data-btp-go')); } catch (e) { return; }
        navigate(t);
      });
    });
    Array.prototype.forEach.call(_host.querySelectorAll('[data-btp-restore]'), function (b) {
      b.addEventListener('click', function () {
        runApply(b.getAttribute('data-btp-kind'), { mode: 'restore', p86Id: b.getAttribute('data-btp-restore') });
      });
    });
    Array.prototype.forEach.call(_host.querySelectorAll('[data-btp-delete]'), function (b) {
      b.addEventListener('click', function () {
        askThen('Permanently delete “' + b.getAttribute('data-btp-delete-label') + '”? This cannot be undone.', 'Delete permanently', function () {
          runApply(b.getAttribute('data-btp-kind'), { mode: 'delete', p86Id: b.getAttribute('data-btp-delete') });
        });
      });
    });
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
          var go = function () { runApply(key, { btIds: [id], fields: fields }); };
          var ask = rowConfirm(key, row, fields);
          if (ask) askThen(ask.message, ask.label, go, ask.danger);
          else go();
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
      Array.prototype.forEach.call(sec.querySelectorAll('[data-btp-merge]'), function (b) {
        b.addEventListener('click', function () {
          var loser = b.getAttribute('data-btp-merge');
          var into = b.getAttribute('data-btp-merge-into');
          askThen('Merge “' + b.getAttribute('data-btp-merge-label') + '” into this Buildertrend-linked ' + (NOUN[key] || 'record') + '? Everything attached to it moves over, and the emptied copy goes to the Archive tab, where it can be restored or deleted.', 'Merge', function () {
            runApply(key, { mode: 'merge', survivorId: into, loserId: loser });
          });
        });
      });
      Array.prototype.forEach.call(sec.querySelectorAll('[data-btp-archive]'), function (b) {
        b.addEventListener('click', function () {
          askThen('Archive “' + b.getAttribute('data-btp-archive-label') + '”? It is set aside in the Archive tab, where it can be restored or deleted.', 'Archive', function () {
            runApply(key, { mode: 'archive', p86Id: b.getAttribute('data-btp-archive') });
          });
        });
      });
      Array.prototype.forEach.call(sec.querySelectorAll('[data-btp-link]'), function (b) {
        b.addEventListener('click', function () {
          runApply(key, { mode: 'link', btId: b.getAttribute('data-btp-link'), p86Id: b.getAttribute('data-btp-link-p86'), btIds: [b.getAttribute('data-btp-link')] });
        });
      });
      Array.prototype.forEach.call(sec.querySelectorAll('[data-btp-create]'), function (b) {
        b.addEventListener('click', function () { runApply(key, { mode: 'create', btIds: [b.getAttribute('data-btp-create')] }); });
      });
      var createAll = sec.querySelector('[data-btp-create-all]');
      if (createAll) {
        createAll.addEventListener('click', function () {
          var ds = _data && _data.datasets && _data.datasets[key];
          askThen(createAllConfirmText(key, ds), 'Create', function () {
            runApply(key, { mode: 'create' });
          });
        });
      }
      var safe = sec.querySelector('[data-btp-apply-safe]');
      if (safe) {
        safe.addEventListener('click', function () {
          var ds = _data && _data.datasets && _data.datasets[key];
          askThen(safeConfirmText(key, ds), 'Apply', function () {
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
      // The Overview walks these, the tabs walk the server's own list, and a
      // dataset in one but not the other is a count that disagrees with the
      // rows it claims to reach. Held against PREVIEW_KINDS by a test.
      DS_ORDER: DS_ORDER,
      WAIT_KINDS: WAIT_KINDS,
      TABS: TABS,
      esc: esc,
      errorSentence: errorSentence,
      render: function (data, err) { _data = data || null; _err = err || null; _loading = false; return pageHTML(); },
      runApply: runApply,
      setView: function (key, f, scope) { _ui[key].f = f || 'all'; if (scope) _ui[key].scope = scope; _ui[key].waitJob = ''; _ui[key].waitJobLabel = ''; _ui[key].shown = PAGE; },
      setTab: function (t) { _tab = t; },
      setArchive: function (a) { _archive = a; _archiveErr = null; },
      resetPicks: function () { _picks = {}; },
      shapeError: shapeError,
      applyResultText: applyResultText,
      safeConfirmText: safeConfirmText,
      rowConfirm: rowConfirm,
      pickedFields: pickedFields,
      createAllConfirmText: createAllConfirmText,
      // The Overview: each figure it prints, and the click that goes with it.
      navigate: navigate,
      countTarget: countTarget,
      blockers: blockers,
      blockerSummary: blockerSummary,
      groups: groups,
      refusalReasons: refusalReasons,
      moneyAtStake: moneyAtStake,
      moneyNum: moneyNum,
      health: health
    }
  };
})();
