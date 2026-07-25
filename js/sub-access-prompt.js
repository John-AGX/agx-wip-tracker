// ───────────────────────────────────────────────────────────────────
// Reusable sub-access permissions popup.
//
// Fires when a sub is assigned to a form (PO editor today; any sub picker
// tomorrow). Shows the sub, whether they have job access, and a per-folder
// checklist for the job — Save reconciles the grants in one shot (grants
// checked folders, revokes unchecked, and assigns the sub to the job so it
// surfaces in their portal).
//
//   window.p86SubAccessPrompt({ subId, subName, jobId, jobName, onDone })
//
// Backed by GET/POST /api/subs/:subId/job-access(/:jobId). Self-contained
// (own modal + styles); theme-aware (body.light-mode).
// ───────────────────────────────────────────────────────────────────
(function () {
  'use strict';

  var FOLDER_LABELS = {
    'general': 'General',
    'contracts': 'Contracts',
    'plans/current': 'Plans — Current',
    'plans/revisions': 'Plans — Revisions',
    'permits': 'Permits',
    'submittals': 'Submittals',
    'rfis': 'RFIs',
    'photos/progress': 'Photos — Progress',
    'photos/before-after': 'Photos — Before / After',
    'change-orders': 'Change Orders',
    'daily-reports': 'Daily Reports',
    'closeout/warranties': 'Closeout — Warranties',
    'closeout/as-builts': 'Closeout — As-builts',
    'safety': 'Safety'
  };
  // Sensible working set pre-checked when a sub has no grants yet.
  var DEFAULT_CHECK = ['general', 'plans/current', 'photos/progress', 'rfis', 'submittals', 'daily-reports', 'safety'];

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function firstName(n) { return String(n || 'They').trim().split(/\s+/)[0] || 'They'; }
  function authH() {
    var t = null; try { t = localStorage.getItem('p86-auth-token'); } catch (e) {}
    var h = { 'Content-Type': 'application/json' };
    if (t) h['Authorization'] = 'Bearer ' + t;
    return h;
  }

  function open(opts) {
    opts = opts || {};
    if (!opts.subId || !opts.jobId) return;
    fetch('/api/subs/' + encodeURIComponent(opts.subId) + '/job-access/' + encodeURIComponent(opts.jobId),
      { headers: authH(), credentials: 'include' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (state) { render(opts, state || { available: ['general'], granted: [], hasJob: false }); })
      .catch(function () { render(opts, { available: ['general'], granted: [], hasJob: false }); });
  }

  function render(opts, state) {
    ensureStyles();
    var available = (state.available && state.available.length) ? state.available : ['general'];
    var granted = state.granted || [];
    var hasAny = granted.length > 0;
    var checked = {};
    (hasAny ? granted : DEFAULT_CHECK).forEach(function (f) { checked[f] = true; });

    var ov = document.createElement('div');
    ov.className = 'p86-sap-overlay';
    ov.innerHTML =
      '<div class="p86-sap-card" role="dialog" aria-modal="true" aria-label="Sub access">'
      + '<div class="p86-sap-hd">'
      + '<div class="p86-sap-ttl">Sub access</div>'
      + '<button class="p86-sap-x" data-sap="cancel" aria-label="Close">&times;</button>'
      + '</div>'
      + '<div class="p86-sap-sub"><strong>' + esc(opts.subName || 'This sub') + '</strong>'
      + (hasAny ? '<span class="p86-sap-tag ok">has access</span>' : '<span class="p86-sap-tag no">no job access</span>')
      + '</div>'
      + '<div class="p86-sap-note">Choose which of <strong>' + esc(opts.jobName || 'this job') + '</strong>’s folders '
      + esc(firstName(opts.subName)) + ' can see in their portal. Saving also adds them to the job.</div>'
      + '<div class="p86-sap-tools"><button class="p86-sap-mini" data-sap="all">Select all</button>'
      + '<button class="p86-sap-mini" data-sap="none">Clear</button></div>'
      + '<div class="p86-sap-folders">'
      + available.map(function (f) {
        return '<label class="p86-sap-row"><input type="checkbox" data-folder="' + esc(f) + '"'
          + (checked[f] ? ' checked' : '') + '><span>' + esc(FOLDER_LABELS[f] || f) + '</span></label>';
      }).join('')
      + '</div>'
      + '<div class="p86-sap-ft">'
      + '<button class="p86-sap-btn ghost" data-sap="cancel">Cancel</button>'
      + '<button class="p86-sap-btn primary" data-sap="save">Save access</button>'
      + '</div></div>';
    document.body.appendChild(ov);

    function close() { if (ov.parentNode) ov.parentNode.removeChild(ov); document.removeEventListener('keydown', onKey); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);
    ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
    ov.querySelectorAll('[data-sap="cancel"]').forEach(function (b) { b.addEventListener('click', close); });
    ov.querySelector('[data-sap="all"]').addEventListener('click', function () {
      ov.querySelectorAll('input[data-folder]').forEach(function (i) { i.checked = true; });
    });
    ov.querySelector('[data-sap="none"]').addEventListener('click', function () {
      ov.querySelectorAll('input[data-folder]').forEach(function (i) { i.checked = false; });
    });
    ov.querySelector('[data-sap="save"]').addEventListener('click', function () {
      var btn = this;
      var folders = Array.prototype.slice.call(ov.querySelectorAll('input[data-folder]:checked'))
        .map(function (i) { return i.getAttribute('data-folder'); });
      btn.disabled = true; btn.textContent = 'Saving…';
      fetch('/api/subs/' + encodeURIComponent(opts.subId) + '/job-access',
        { method: 'POST', headers: authH(), credentials: 'include', body: JSON.stringify({ jobId: opts.jobId, folders: folders }) })
        .then(function (r) { return r.json().catch(function () { return null; }); })
        .then(function (res) {
          close();
          if (typeof opts.onDone === 'function') { try { opts.onDone(res); } catch (e) {} }
          var msg = folders.length
            ? (esc(opts.subName || 'Sub') + ' — ' + folders.length + ' folder' + (folders.length === 1 ? '' : 's') + ' granted')
            : (esc(opts.subName || 'Sub') + ' — folder access removed');
          if (typeof window.p86Toast === 'function') window.p86Toast(msg);
        })
        .catch(function () { btn.disabled = false; btn.textContent = 'Save access'; });
    });
  }

  function ensureStyles() {
    if (document.getElementById('p86-sap-styles')) return;
    var css = ''
      + '.p86-sap-overlay{position:fixed;inset:0;z-index:100000;background:rgba(8,11,18,.62);display:flex;align-items:center;justify-content:center;padding:16px;backdrop-filter:blur(2px);}'
      + '.p86-sap-card{width:100%;max-width:420px;max-height:88vh;overflow:auto;background:#161a21;color:#e7e9ee;border:1px solid #2a303b;border-radius:14px;box-shadow:0 18px 60px rgba(0,0,0,.5);font-family:inherit;}'
      + 'body.light-mode .p86-sap-card{background:#fff;color:#16181d;border-color:#e4e6eb;box-shadow:0 18px 60px rgba(20,24,33,.18);}'
      + '.p86-sap-hd{display:flex;align-items:center;justify-content:space-between;padding:15px 17px 6px;}'
      + '.p86-sap-ttl{font-size:12px;letter-spacing:.11em;text-transform:uppercase;font-weight:700;color:#7a828f;}'
      + '.p86-sap-x{background:none;border:none;color:#7a828f;font-size:22px;line-height:1;cursor:pointer;padding:0 2px;}'
      + '.p86-sap-x:hover{color:#e7e9ee;}body.light-mode .p86-sap-x:hover{color:#16181d;}'
      + '.p86-sap-sub{padding:0 17px;font-size:17px;display:flex;align-items:center;gap:9px;flex-wrap:wrap;}'
      + '.p86-sap-tag{font-size:10.5px;font-weight:700;letter-spacing:.03em;padding:2px 8px;border-radius:20px;text-transform:uppercase;}'
      + '.p86-sap-tag.ok{background:rgba(47,125,91,.18);color:#5fbe93;}'
      + '.p86-sap-tag.no{background:rgba(176,67,46,.16);color:#e8836b;}'
      + '.p86-sap-note{padding:8px 17px 2px;font-size:13px;color:#aab2bf;line-height:1.45;}'
      + 'body.light-mode .p86-sap-note{color:#4a505b;}'
      + '.p86-sap-tools{display:flex;gap:8px;padding:10px 17px 4px;}'
      + '.p86-sap-mini{font-size:11.5px;font-weight:600;color:#5aa9de;background:none;border:none;cursor:pointer;padding:2px 0;}'
      + 'body.light-mode .p86-sap-mini{color:#2c6e9b;}'
      + '.p86-sap-folders{padding:4px 17px 6px;display:grid;grid-template-columns:1fr 1fr;gap:2px 14px;}'
      + '@media(max-width:460px){.p86-sap-folders{grid-template-columns:1fr;}}'
      + '.p86-sap-row{display:flex;align-items:center;gap:9px;padding:7px 2px;font-size:13.5px;cursor:pointer;border-radius:6px;}'
      + '.p86-sap-row:hover{background:rgba(255,255,255,.04);}body.light-mode .p86-sap-row:hover{background:#f3f4f7;}'
      + '.p86-sap-row input{width:16px;height:16px;accent-color:#2f7d5b;flex:none;cursor:pointer;}'
      + '.p86-sap-ft{display:flex;justify-content:flex-end;gap:10px;padding:12px 17px 16px;position:sticky;bottom:0;background:inherit;}'
      + '.p86-sap-btn{font-size:13.5px;font-weight:600;padding:9px 16px;border-radius:9px;cursor:pointer;border:1px solid transparent;}'
      + '.p86-sap-btn.ghost{background:none;border-color:#2a303b;color:#aab2bf;}'
      + 'body.light-mode .p86-sap-btn.ghost{border-color:#d7dae0;color:#4a505b;}'
      + '.p86-sap-btn.primary{background:#2f7d5b;color:#fff;}.p86-sap-btn.primary:hover{background:#35906a;}'
      + '.p86-sap-btn:disabled{opacity:.6;cursor:default;}';
    var st = document.createElement('style');
    st.id = 'p86-sap-styles';
    st.textContent = css;
    document.head.appendChild(st);
  }

  window.p86SubAccessPrompt = open;
})();
