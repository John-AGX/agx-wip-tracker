/* ──────────────────────────────────────────────────────────────────────────
 * js/save-banner.js — the visible half of the save path.
 *
 * THE RULE IT EXISTS FOR
 * If a write cannot reach the server, the user must know, in the UI, at the
 * time. Not in a console.warn, not in a toast that fires while the tab is in
 * the background, and not as a green ✓ computed before the request resolved.
 * A retry that silently succeeds later is fine. A retry that silently fails
 * forever is the same bug with more code.
 *
 * WHY A BANNER AND NOT A TOAST
 * A toast is a moment; this is a STATE. The failure it reports can last a
 * whole Railway deploy window, and the user is frequently looking at another
 * tab when it starts. It stays until the state that raised it is over.
 *
 * EVERY STRING COMES FROM p86SaveMerge.describeSaveState(), which is a pure
 * function with its own tests. This file decides only WHEN to ask and WHERE to
 * paint. That split is deliberate: the claim being made ("N changes are on
 * this device only") is a factual claim about the persistence layer, and a
 * claim that can be tested is a claim that can be kept true.
 *
 * WHAT IT DELIBERATELY DOES NOT OFFER
 *   - "Save them". In the state where it reads most naturally (reconnected,
 *     changes still local) the only way to honour it would be to bypass the
 *     pushToServer guard — a full bulk replace from a possibly-stale cache
 *     with the concurrency check off. A button that cannot do what it says is
 *     the defect this file was written against.
 *   - "Discard". Nothing needs it: the hydrate is held rather than run, so
 *     nothing is stuck behind discarding. And it would permanently burn a job
 *     number, which saveJob claims atomically before the job object exists.
 * ────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';
  if (typeof window === 'undefined' || !window.document) return;

  var EL_ID = 'p86-save-banner';
  var _state = { reason: null, detail: null, at: 0 };
  var _tick = null;

  function merge() { return window.p86SaveMerge; }

  /* Read the live truth rather than trusting the event that woke us. The
   * event says what just happened; p86SaveState() says what is true NOW,
   * including which rows are actually still unsaved — so a banner cannot
   * outlive the condition it describes. */
  function snapshot() {
    var s = (typeof window.p86SaveState === 'function') ? window.p86SaveState() : null;
    if (!s) return null;
    var d = _state.detail || {};
    return {
      reason: _state.reason,
      jobs: s.jobs || [],
      estimates: s.estimates || [],
      heldMs: _state.at ? (Date.now() - _state.at) : 0,
      retryAttempt: s.retryAttempt || 0,
      escalate: !!d.escalate,
      // Carried from the 'partial' status: the ids the server refused because
      // the row is GONE, not because it moved on. Different fact, different copy.
      deleted: d.deleted || [],
      quotaFailed: !!(window.appData && window.appData._cacheWriteFailed)
    };
  }

  function paint() {
    var host = document.getElementById(EL_ID);
    var m = merge();
    var snap = snapshot();
    if (!m || !snap) { if (host) host.remove(); return; }

    // Nothing unsaved => nothing to say, whatever the last event was. This is
    // the self-clearing property: the banner is a function of the dirty set,
    // so a push that lands removes it without anyone having to remember to.
    //
    // 'no-good-load' used to be exempt from this, and that exemption is what
    // put a RED "Not saving to the server — 0 changes on this device only"
    // in front of John on every Railway swap with nothing unsaved. The rule
    // has no exceptions now: no unsaved rows, no banner. describeSaveState
    // enforces the same thing from its side, so neither layer can reintroduce
    // it alone.
    var view = (snap.jobs.length + snap.estimates.length) === 0
      ? { level: 'none' }
      : m.describeSaveState(snap);

    if (view.level === 'none') { if (host) host.remove(); stopTick(); return; }

    if (!host) {
      host = document.createElement('div');
      host.id = EL_ID;
      host.setAttribute('role', 'status');
      host.setAttribute('aria-live', 'polite');
      document.body.appendChild(host);
    }
    host.className = 'p86-save-banner is-' + view.level;
    host.innerHTML =
      '<div class="p86-sb-text">' +
        '<strong></strong> <span></span>' +
      '</div><div class="p86-sb-actions"></div>';
    // textContent, not interpolation: job and estimate titles are user data
    // and this banner renders in every state including the panicky ones.
    host.querySelector('strong').textContent = view.title;
    host.querySelector('span').textContent = view.detail;

    var actions = host.querySelector('.p86-sb-actions');
    view.actions.forEach(function (a) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'p86-sb-btn';
      b.textContent = LABEL[a] || a;
      b.onclick = HANDLER[a] || function () {};
      actions.appendChild(b);
    });
    startTick();
  }

  var LABEL = {
    'try-now': 'Try now',
    'retry-now': 'Retry now',
    'show-unsaved': 'Show what’s unsaved'
  };
  var HANDLER = {
    'try-now': function () {
      if (typeof window.p86TryReconnect === 'function') window.p86TryReconnect();
    },
    'retry-now': function () {
      // The push path, not the load path. flushPendingSave asks the dirty set
      // and no-ops when there is nothing to send, so this cannot manufacture a
      // write. It also cannot bypass the "no good load yet" guard — in that
      // state the honest action is Try now, which is the one offered.
      if (typeof window.p86FlushSave === 'function') { try { window.p86FlushSave(); } catch (e) {} }
    },
    'show-unsaved': function () {
      var s = (typeof window.p86SaveState === 'function') ? window.p86SaveState() : null;
      if (!s) return;
      var lines = [];
      if (s.jobs.length) lines.push('Jobs:\n  • ' + s.jobs.join('\n  • '));
      if (s.estimates.length) lines.push('Estimates:\n  • ' + s.estimates.join('\n  • '));
      var body = lines.length
        ? lines.join('\n\n') + '\n\nThese are held on this device. Keep this tab open until the banner clears.'
        : 'Nothing is unsaved right now.';
      if (typeof window.p86Alert === 'function') {
        window.p86Alert({ title: 'Not yet on the server', message: body });
      } else {
        // Native alert() is a no-op inside the installed PWA, so this is the
        // last-resort path only; p86Alert is the one that actually shows.
        try { alert(body); } catch (e) { console.warn('[p86 unsaved]\n' + body); }
      }
    }
  };

  /* The copy for two states is time-dependent (the "still can't reach the
   * server" escalation, and the quiet window that keeps a routine 300ms
   * refresh from painting a red banner at all), so it has to be re-evaluated
   * while the state persists rather than only on events. */
  function startTick() { if (!_tick) _tick = setInterval(paint, 1000); }
  function stopTick() { if (_tick) { clearInterval(_tick); _tick = null; } }

  function onStatus(status, detail) {
    detail = (detail && typeof detail === 'object') ? detail : {};
    switch (status) {
      case 'blocked':
        if (_state.reason !== detail.reason) _state.at = Date.now();
        _state.reason = detail.reason || 'no-good-load';
        _state.detail = detail;
        break;
      case 'load-failed':
        if (_state.reason !== 'no-good-load') _state.at = Date.now();
        _state.reason = 'no-good-load';
        _state.detail = detail;
        break;
      case 'failed':
        if (_state.reason !== 'push-failed') _state.at = Date.now();
        _state.reason = 'push-failed';
        _state.detail = detail;
        break;
      case 'partial':
        _state.reason = 'partial'; _state.detail = detail; _state.at = Date.now();
        break;
      case 'saved':
      case 'idle':
        _state.reason = null; _state.detail = null; _state.at = 0;
        break;
      // 'saving' and 'retrying' deliberately do not change the reason. They
      // are progress within whatever state we are already in, and letting
      // 'retrying' overwrite 'no-good-load' would lose the distinction between
      // "the server is unreachable" and "a push bounced once".
      default: break;
    }
    paint();
  }

  /* Styles ship with the module rather than in css/, so the banner is one
   * file with one cache-bust rather than two that can drift apart. Colours go
   * through the app's CSS vars with literal fallbacks, because this thing has
   * to render correctly in the state where other machinery is failing. */
  function injectStyles() {
    if (document.getElementById('p86-save-banner-css')) return;
    var st = document.createElement('style');
    st.id = 'p86-save-banner-css';
    st.textContent =
      '.p86-save-banner{position:fixed;left:50%;transform:translateX(-50%);bottom:18px;z-index:99999;' +
      'max-width:min(720px,calc(100vw - 24px));display:flex;gap:14px;align-items:center;flex-wrap:wrap;' +
      'padding:11px 16px;border-radius:10px;font-size:13.5px;line-height:1.45;' +
      'box-shadow:0 8px 28px rgba(0,0,0,.35);border:1px solid transparent;}' +
      '.p86-save-banner.is-warn{background:var(--panel,#1c1f26);color:var(--text,#e6e6e6);' +
      'border-color:var(--yellow,#d97706);}' +
      '.p86-save-banner.is-error{background:var(--panel,#1c1f26);color:var(--text,#e6e6e6);' +
      'border-color:var(--red,#f87171);}' +
      '.p86-save-banner .p86-sb-text strong{display:block;margin-bottom:2px;}' +
      '.p86-save-banner.is-error .p86-sb-text strong{color:var(--red,#f87171);}' +
      '.p86-save-banner.is-warn .p86-sb-text strong{color:var(--yellow,#d97706);}' +
      '.p86-save-banner .p86-sb-actions{display:flex;gap:8px;margin-left:auto;}' +
      '.p86-sb-btn{background:transparent;border:1px solid currentColor;color:inherit;' +
      'border-radius:6px;padding:5px 11px;font-size:12.5px;cursor:pointer;white-space:nowrap;}' +
      '.p86-sb-btn:hover{background:rgba(127,127,127,.18);}' +
      '@media (max-width:640px){.p86-save-banner{bottom:70px;}}';
    document.head.appendChild(st);
  }

  function boot() {
    injectStyles();
    if (window.p86PushStatus && typeof window.p86PushStatus.subscribe === 'function') {
      window.p86PushStatus.subscribe(onStatus);
    }
    paint();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  window.p86SaveBanner = { refresh: paint, _onStatus: onStatus };
})();
