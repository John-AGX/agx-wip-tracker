// Background Tasks — the user-facing surface for agent_jobs (background-tasks plan).
//
// A small floating launcher (appears only when there are active or unseen tasks)
// opens a panel listing the user's background tasks with status + result. Polls
// /api/agent-jobs for the badge. Fully self-contained (injects its own DOM + CSS),
// so it touches nothing in the header/nav layout. Answering a needs_input task from
// here lands in S5; for now the panel points the user at their 86 chat.
(function () {
  'use strict';

  // ══ PUSH KEY RECOVERY — exported core ═══════════════════════════════════
  // The decision ("is this device's subscription still minted against the key
  // the server signs with?") and the repair are pure/injected so they are
  // provable in Jest without a browser. Everything below the Node bail is the
  // DOM half. See the long note above keyState() for the defect this closes.
  var PUSH_PENDING_KEY = 'p86-push-resub';
  var VAPID_KEY_BYTES = 65;   // uncompressed P-256 point; VAPID is P-256 only

  var PushRecovery = {
    PENDING_KEY: PUSH_PENDING_KEY,
    VAPID_KEY_BYTES: VAPID_KEY_BYTES,
    urlB64ToU8: urlB64ToU8,
    keyState: keyState,
    reconcile: reconcile
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = PushRecovery;
  if (typeof window === 'undefined') return;   // Node: the pure recovery core only.
  window.p86PushRecovery = PushRecovery;

  if (window.p86AgentTasks) return;

  var POLL_MS = 20000;
  var _jobs = [];
  var _attention = 0;
  var _timer = null;
  var _panelOpen = false;

  function apiGet(path) {
    if (window.p86Api && window.p86Api.get) return window.p86Api.get('/api/agent-jobs' + path);
    return fetch('/api/agent-jobs' + path, { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); });
  }
  function apiPost(path, body) {
    if (window.p86Api && window.p86Api.post) return window.p86Api.post('/api/agent-jobs' + path, body || {});
    return fetch('/api/agent-jobs' + path, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {})
    }).then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); });
  }

  function statusMeta(s) {
    switch (s) {
      case 'queued':      return { label: 'Queued',    color: '#8b90a5' };
      case 'running':     return { label: 'Working…',  color: '#4f8cff' };
      case 'needs_input': return { label: 'Needs you', color: '#fbbf24' };
      case 'done':        return { label: 'Done',      color: '#34d399' };
      case 'failed':      return { label: 'Failed',    color: '#f87171' };
      case 'canceled':    return { label: 'Canceled',  color: '#8b90a5' };
      default:            return { label: s || '—',    color: '#8b90a5' };
    }
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function ensureStyle() {
    if (document.getElementById('p86-agent-tasks-css')) return;
    var st = document.createElement('style'); st.id = 'p86-agent-tasks-css';
    st.textContent = [
      // Colors route through the theme vars (dark values as fallbacks) so the
      // panel renders correctly in BOTH modes — hardcoded darks made it an
      // unreadable dark island in light mode.
      // The crew-activity trigger now lives in the 86 chat header
      // (#ai-crew-activity, built by ai-panel.js); the old floating pill is
      // retired. .p86-bgt-dot/.p86-bgt-badge are reused by that button + panel.
      '.p86-bgt-dot{width:8px;height:8px;border-radius:50%;background:#4f8cff}',
      '.p86-bgt-badge{background:#fbbf24;color:#1a1400;border-radius:10px;padding:1px 7px;font-size:11px;font-weight:800}',
      // Ambient "needs you" badge on the header/mobile Ask-86 button, so a
      // paused background task is visible without opening the chat.
      '.p86-ask86-attn{position:absolute;top:-4px;right:-4px;min-width:16px;height:16px;box-sizing:border-box;padding:0 4px;border-radius:8px;background:#fbbf24;color:#1a1400;font:800 10px/16px system-ui,sans-serif;text-align:center;pointer-events:none;box-shadow:0 0 0 2px rgba(15,15,20,.85);z-index:3}',
      // Soft blue pulse ring on the header button while the crew is working.
      '#ai-crew-activity.p86-bgt-running{animation:p86CrewPulse 1.8s ease-in-out infinite}',
      '@keyframes p86CrewPulse{0%,100%{box-shadow:0 0 0 0 rgba(79,140,255,0)}50%{box-shadow:0 0 0 3px rgba(79,140,255,.30)}}',
      // Panel: dim overlay + bottom-right card, now with a smooth fade + slide
      // in/out (was an instant display toggle).
      '.p86-bgt-overlay{position:fixed;inset:0;z-index:9001;background:rgba(4,6,12,.5);display:flex;align-items:flex-end;justify-content:flex-end;opacity:0;visibility:hidden;pointer-events:none;transition:opacity .2s ease, visibility .2s ease}',
      '.p86-bgt-overlay.on{opacity:1;visibility:visible;pointer-events:auto}',
      '.p86-bgt-panel{margin:0 16px 16px 0;width:min(440px,calc(100vw - 32px));max-height:min(72vh,660px);display:flex;flex-direction:column;background:var(--surface,#0f1320);border:1px solid var(--border,rgba(255,255,255,.14));border-radius:14px;overflow:hidden;box-shadow:0 12px 44px rgba(0,0,0,.6);transform:translateY(14px) scale(.985);opacity:0;transition:transform .26s cubic-bezier(.2,.8,.2,1), opacity .2s ease;will-change:transform,opacity}',
      '.p86-bgt-overlay.on .p86-bgt-panel{transform:none;opacity:1}',
      '@media (prefers-reduced-motion:reduce){.p86-bgt-overlay,.p86-bgt-panel{transition:none}}',
      '.p86-bgt-head{display:flex;align-items:center;justify-content:space-between;padding:13px 15px;border-bottom:1px solid var(--border,rgba(255,255,255,.08));color:var(--text,#e6e9f0);font:700 14px/1 system-ui,sans-serif}',
      '.p86-bgt-x{background:none;border:none;color:var(--text-dim,#9aa0b2);font-size:18px;cursor:pointer;line-height:1}',
      '.p86-bgt-body{overflow:auto;flex:1 1 auto;min-height:0;-webkit-overflow-scrolling:touch}',
      '.p86-bgt-list{padding:8px}',
      '.p86-bgt-item{border:1px solid var(--border,rgba(255,255,255,.08));border-radius:10px;padding:11px 12px;margin-bottom:8px;background:var(--surface2,#141824)}',
      '.p86-bgt-draft{cursor:pointer}',
      '.p86-bgt-draft:hover{border-color:rgba(96,165,250,.55)}',
      '.p86-bgt-draft:focus-visible{outline:2px solid #60a5fa;outline-offset:1px}',
      '.p86-bgt-t{display:flex;align-items:center;justify-content:space-between;gap:8px;color:var(--text,#e6e9f0);font:600 13px/1.3 system-ui,sans-serif}',
      '.p86-bgt-pill{font-size:11px;font-weight:700;padding:2px 8px;border-radius:9px;white-space:nowrap}',
      '.p86-bgt-body{margin-top:7px;color:var(--text-dim,#aeb4c4);font:400 12px/1.5 system-ui,sans-serif;white-space:pre-wrap;word-break:break-word}',
      '.p86-bgt-q{margin-top:7px;color:var(--yellow,#fbbf24);font:600 12px/1.5 system-ui,sans-serif}',
      '.p86-bgt-empty{color:var(--text-dim,#8b90a5);text-align:center;padding:30px 14px;font:400 13px/1.6 system-ui,sans-serif}',
      '.p86-bgt-answer{display:flex;gap:6px;margin-top:8px}',
      '.p86-bgt-answer-in{flex:1;min-width:0;background:var(--input-bg,#0f1320);border:1px solid var(--border,rgba(255,255,255,.16));border-radius:8px;padding:7px 10px;color:var(--text,#e6e9f0);font:400 12px/1.3 system-ui,sans-serif;outline:none}',
      '.p86-bgt-answer-in:focus{border-color:#4f8cff}',
      '.p86-bgt-answer-btn{background:#4f8cff;color:#fff;border:none;border-radius:8px;padding:0 14px;font:600 12px/1 system-ui,sans-serif;cursor:pointer}',
      '.p86-bgt-answer-btn:hover{background:#3d7aef}'
    ].join('');
    document.head.appendChild(st);
  }

  function ensureDom() {
    ensureStyle();
    if (document.querySelector('.p86-bgt-overlay')) return;
    var ov = document.createElement('div');
    ov.className = 'p86-bgt-overlay';
    ov.innerHTML = '<div class="p86-bgt-panel"><div class="p86-bgt-head"><span>Crew activity</span><span style="display:flex;gap:8px;align-items:center"><button class="p86-bgt-bell" title="Get phone/desktop notifications when a task finishes or needs you" style="display:none;background:none;border:1px solid rgba(255,255,255,.18);border-radius:8px;color:#aeb4c4;font:600 11px/1 system-ui,sans-serif;padding:5px 9px;cursor:pointer">🔔 Enable notifications</button><button class="p86-bgt-x" title="Close">✕</button></span></div><div class="p86-bgt-body"><div class="p86-bgt-list"></div><div class="p86-bgt-scribe"></div></div></div>';
    ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
    ov.querySelector('.p86-bgt-x').addEventListener('click', close);
    ov.querySelector('.p86-bgt-bell').addEventListener('click', enablePush);
    document.body.appendChild(ov);
    updateBellVisibility();
    var listEl = ov.querySelector('.p86-bgt-list');
    listEl.addEventListener('click', function (e) {
      var btn = e.target.closest && e.target.closest('.p86-bgt-answer-btn');
      if (btn) submitAnswerFor(btn.getAttribute('data-jid'), listEl);
    });
    listEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && e.target.classList && e.target.classList.contains('p86-bgt-answer-in')) {
        e.preventDefault(); submitAnswerFor(e.target.getAttribute('data-jid'), listEl);
      }
    });
  }

  // Ambient "needs you" badge on the header + mobile Ask-86 buttons — visible
  // WITHOUT opening the chat. Self-heals if the icon system re-decorates the
  // button (recreates the badge span when absent).
  function updateAskBadge() {
    var hosts = [
      // Desktop: the crew chip is now the single header chat entry (the
      // standalone #header-ask86-btn was removed). Mobile keeps its bottom-nav
      // Ask-86 slot. Both are null-safe below.
      document.getElementById('p86CrewChip'),
      document.querySelector('#p86-mobile-nav [data-mobile-nav="ask86"]')
    ];
    hosts.forEach(function (host) {
      if (!host) return;
      var b = host.querySelector('.p86-ask86-attn');
      if (_attention > 0) {
        if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
        if (!b) { b = document.createElement('span'); b.className = 'p86-ask86-attn'; host.appendChild(b); }
        b.textContent = _attention > 9 ? '9+' : _attention;
        b.style.display = '';
        host.setAttribute('data-crew-attn', _attention);
      } else if (b) {
        b.style.display = 'none';
        host.removeAttribute('data-crew-attn');
      }
    });
  }

  // Reflect state onto the crew-activity button in the 86 chat header
  // (built lazily by ai-panel.js). No-op until the chat panel exists; the
  // 20s poll + the panel's own refresh() call keep it current after that.
  function renderLauncher() {
    updateAskBadge();  // ambient signal — runs regardless of chat-open state
    var btn = document.getElementById('ai-crew-activity'); if (!btn) return;
    var badge = btn.querySelector('.p86-bgt-badge');
    if (badge) {
      if (_attention > 0) { badge.style.display = ''; badge.textContent = _attention; }
      else { badge.style.display = 'none'; }
    }
    var running = _jobs.filter(function (j) { return j.status === 'running'; }).length;
    btn.classList.toggle('p86-bgt-running', running > 0);
    btn.title = running
      ? (running + ' task' + (running > 1 ? 's' : '') + ' running — Crew activity')
      : 'Crew activity — background tasks & Scribe drafts';
  }

  function renderPanel() {
    var list = document.querySelector('.p86-bgt-list'); if (!list) return;
    if (!_jobs.length) {
      list.innerHTML = '<div class="p86-bgt-empty">No background tasks yet.<br>Ask 86 or the assistant to take on something bigger, or say “do this in the background.”</div>';
      return;
    }
    list.innerHTML = _jobs.map(function (j) {
      var m = statusMeta(j.status);
      var pill = '<span class="p86-bgt-pill" style="background:' + m.color + '22;color:' + m.color + '">' + esc(m.label) + '</span>';
      var body = '';
      if (j.status === 'needs_input' && j.pause_question) {
        body = '<div class="p86-bgt-q">❓ ' + esc(j.pause_question) + '</div>' +
          '<div class="p86-bgt-answer"><input class="p86-bgt-answer-in" type="text" placeholder="Your answer…" autocomplete="off" data-jid="' + esc(j.id) + '"><button class="p86-bgt-answer-btn" data-jid="' + esc(j.id) + '">Send</button></div>';
      } else if (j.status === 'done' && j.result) {
        body = '<div class="p86-bgt-body">' + esc(j.result) + '</div>';
      } else if (j.status === 'failed' && j.error) {
        body = '<div class="p86-bgt-body" style="color:#f87171">' + esc(j.error) + '</div>';
      } else if (j.status === 'running' || j.status === 'queued') {
        body = '<div class="p86-bgt-body">' + esc((j.prompt || '').slice(0, 160)) + '</div>';
      }
      return '<div class="p86-bgt-item"><div class="p86-bgt-t"><span>' + esc(j.title || 'Task') + '</span>' + pill + '</div>' + body + '</div>';
    }).join('');
  }

  // ── Web Push (S7): the "🔔 Enable notifications" bell ──
  // Shows only when the server has VAPID configured, the browser supports push,
  // permission isn't denied, and there's no existing subscription. No-ops cleanly
  // everywhere else (incl. iOS Safari not installed to home screen).
  function urlB64ToU8(base64) {
    var pad = '='.repeat((4 - base64.length % 4) % 4);
    var b64 = (base64 + pad).replace(/-/g, '+').replace(/_/g, '/');
    var raw = atob(b64); var arr = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
    return arr;
  }
  // ── Key-rotation recovery ────────────────────────────────────────────────
  // Rotating the platform VAPID pair (server/routes/admin-push-routes.js)
  // invalidates every subscription in existence, because each one was minted
  // by the browser against the OLD public key. Nothing in the product noticed:
  // the bell reveals itself only when getSubscription() resolves EMPTY, and
  // after a rotation the browser still holds its (now unusable) subscription,
  // so push went silent on every device with no error surfaced anywhere.
  //
  // The repair is to compare the key the subscription was minted with against
  // the key the server currently serves, and re-mint on a mismatch.
  //
  // THE DANGEROUS DIRECTION IS FALSE POSITIVES. Almost every device reaching
  // this code is fine, and a spurious "repair" would break push for everyone
  // to fix it for nobody. So the only state that touches anything is a
  // POSITIVELY PROVEN mismatch — "I could not tell" is a no-op, deliberately.
  function keyState(subOptions, serverKeyB64) {
    if (!serverKeyB64 || typeof serverKeyB64 !== 'string') return 'unknown';
    // PushSubscription.options is not populated on every engine. When it is
    // absent there is no evidence of a mismatch, so there is no mandate to
    // destroy a subscription that may well be working.
    if (!subOptions) return 'unknown';
    var raw = subOptions.applicationServerKey;
    if (!raw || typeof raw !== 'object' || typeof raw.byteLength !== 'number' || raw.byteLength === 0) return 'unknown';
    var have, want;
    // Compare RAW BYTES, never re-encoded strings. Going the other way — turning
    // the ArrayBuffer back into base64 — means choosing a padding convention and
    // an alphabet, and getting either wrong produces a silent false mismatch,
    // which is precisely the failure mode that must not exist here.
    try { have = (raw instanceof Uint8Array) ? raw : new Uint8Array(raw); } catch (e) { return 'unknown'; }
    try { want = urlB64ToU8(serverKeyB64); } catch (e) { return 'unknown'; }
    // VAPID is P-256 only (RFC 8292), so both sides are an uncompressed EC
    // point: exactly 65 bytes. Anything else on EITHER side means the
    // comparison is not trustworthy — a truncated or garbled key from the
    // server must read as "cannot tell", never as "mismatch", or one bad
    // response would unsubscribe every device in the fleet at once.
    if (have.length !== VAPID_KEY_BYTES || want.length !== VAPID_KEY_BYTES) return 'unknown';
    var diff = 0;
    for (var i = 0; i < have.length; i++) diff |= have[i] ^ want[i];
    return diff === 0 ? 'match' : 'mismatch';
  }

  // Every effect is injected, so this is the whole decision tree and it runs
  // headlessly. Resolves to { action, ... } naming exactly what happened.
  function reconcile(io) {
    function R(action, extra) {
      var o = { action: action };
      if (extra) { for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) o[k] = extra[k]; }
      return o;
    }
    return Promise.resolve().then(function () {
      // Someone who never granted notification permission has nothing to
      // repair, and a background reconcile must never raise a prompt.
      if (io.permission !== 'granted') return R('skipped-permission');
      if (!io.configured || !io.serverKey) return R('skipped-unconfigured');
      return io.getSubscription().then(function (sub) {
        var pending = !!io.isPending();
        if (!sub) {
          // Either someone who never enabled push — the bell owns that, leave
          // it alone — or a device that unsubscribed and then failed to
          // re-subscribe. The marker tells those two apart, and the second is
          // repaired here, automatically, on the very next page load.
          if (!pending) return R('no-subscription');
          return resubscribe(io, null);
        }
        var state = keyState(sub.options, io.serverKey);
        if (state === 'unknown') {
          // Defined, safe, non-looping: say so once and change nothing.
          io.log('warn', 'this subscription does not expose applicationServerKey, so a key ' +
            'rotation cannot be detected on this device; leaving the subscription untouched');
          return R('unknown');
        }
        if (state === 'match') {
          // ── THE OVERWHELMINGLY COMMON CASE ──
          // Zero network calls, zero subscription changes, nothing at all —
          // unless this device is mid-repair, meaning the browser half already
          // succeeded and only the server row is missing.
          if (!pending) return R('noop');
          return io.saveSubscription(sub.toJSON()).then(function () {
            io.setPending(false);
            return R('server-row-repaired', { endpoint: sub.endpoint });
          }, function (e) {
            io.log('error', 'could not save the re-minted subscription to the server; ' +
              'the next page load retries', e);
            return R('server-row-repair-failed', { recoverable: true });
          });
        }
        // ── PROVEN MISMATCH ──
        // pushManager.subscribe() rejects with InvalidStateError while a
        // subscription with a DIFFERENT applicationServerKey is held, so the
        // unsubscribe is forced to come first — that ordering is the browser's,
        // not a choice. What is a choice is the marker, written BEFORE the
        // destructive step, so a crash, a closed tab, or a failed subscribe
        // between the two is still repairable on the next load rather than a
        // device silently stranded with no subscription.
        io.setPending(true);
        var oldEndpoint = sub.endpoint;
        return io.unsubscribe(sub).then(null, function (e) {
          io.log('warn', 'unsubscribe of the stale subscription failed; re-subscribing anyway', e);
          return false;
        }).then(function () {
          return resubscribe(io, oldEndpoint);
        });
      });
    }).then(null, function (e) {
      io.log('error', 'push reconcile threw', e);
      return R('error', { recoverable: true });
    });
  }

  function resubscribe(io, oldEndpoint) {
    var keyBytes;
    try { keyBytes = urlB64ToU8(io.serverKey); }
    catch (e) {
      io.log('error', 'the server push key did not decode; not re-subscribing', e);
      return Promise.resolve({ action: 'resubscribe-failed', recoverable: true });
    }
    function attempt() { return io.subscribe(keyBytes); }
    return attempt().then(null, function (e1) {
      io.log('warn', 're-subscribe attempt failed, retrying once', e1);
      return attempt();
    }).then(function (fresh) {
      if (!fresh) {
        io.log('error', 'RE-SUBSCRIBE FAILED (browser returned no subscription). This device ' +
          'has no push subscription right now; the bell in Crew activity re-enables it and ' +
          'the next page load retries automatically.');
        return { action: 'resubscribe-failed', recoverable: true };
      }
      // NEW ROW FIRST, old row second. Reversed, a failure here would leave the
      // user with no subscription row at all; this way the worst case is one
      // duplicate dead row, which is cosmetic.
      return io.saveSubscription(fresh.toJSON()).then(function () {
        io.setPending(false);
        if (oldEndpoint && oldEndpoint !== fresh.endpoint) {
          // sendPush prunes only on 404/410 and a VAPID mismatch is neither, so
          // without this the old row sits in push_subscriptions forever and
          // every future send retries and logs against it. Best-effort, and
          // deliberately only after the replacement row is safely stored.
          io.dropSubscription(oldEndpoint).then(null, function (e) {
            io.log('warn', 'stale subscription row not dropped for ' + oldEndpoint, e);
          });
        }
        return { action: 'healed', oldEndpoint: oldEndpoint || null, endpoint: fresh.endpoint };
      }, function (e) {
        io.log('error', 're-subscribed, but saving the new subscription to the server failed; ' +
          'the marker stays set so the next page load retries the save', e);
        return { action: 'save-failed', recoverable: true, endpoint: fresh.endpoint };
      });
    }, function (e) {
      // The device is genuinely unsubscribed at this point. That is LOUD, not
      // silent: the marker stays set (next load retries), getSubscription() now
      // resolves empty so the existing bell reveals itself, and this is an
      // error in the console rather than an empty .catch().
      io.log('error', 'RE-SUBSCRIBE FAILED. This device has no push subscription right now; ' +
        'the bell in Crew activity re-enables it and the next page load retries automatically.', e);
      return { action: 'resubscribe-failed', recoverable: true };
    });
  }

  // ── Browser wiring for the core above ────────────────────────────────────
  var _recoveryRan = false;

  function pushLog(level, msg, err) {
    try {
      var line = '[p86-push] ' + msg +
        (err && err.name ? ' (' + err.name + ': ' + (err.message || '') + ')' : '');
      if (level === 'error') console.error(line); else console.warn(line);
    } catch (e) { /* console unavailable — nothing else to do */ }
  }
  // localStorage can be full or blocked (see the quota class of bugs); a marker
  // we cannot write degrades to "no auto-retry", never to a thrown reconcile.
  function pushPending() {
    try { return localStorage.getItem(PUSH_PENDING_KEY) === '1'; } catch (e) { return false; }
  }
  function setPushPending(v) {
    try { if (v) localStorage.setItem(PUSH_PENDING_KEY, '1'); else localStorage.removeItem(PUSH_PENDING_KEY); }
    catch (e) { pushLog('warn', 'could not persist the re-subscribe marker', e); }
  }
  function postSubscription(json) {
    return fetch('/api/push/subscribe', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(json)
    }).then(function (r) { if (!r.ok) throw new Error('subscribe HTTP ' + r.status); return r; });
  }
  function postUnsubscribe(endpoint) {
    return fetch('/api/push/unsubscribe', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: endpoint })
    }).then(function (r) { if (!r.ok) throw new Error('unsubscribe HTTP ' + r.status); return r; });
  }

  // `sub` and `serverKey` are the ones updateBellVisibility already holds, so a
  // healthy device reaches and leaves this function having made NO additional
  // network request and NO subscription call. Latched to one run per page load
  // so the destructive branch can never re-enter.
  function runPushRecovery(reg, sub, serverKey, bell) {
    if (_recoveryRan) return Promise.resolve(null);
    _recoveryRan = true;
    return reconcile({
      permission: Notification.permission,
      configured: true,
      serverKey: serverKey,
      isPending: pushPending,
      setPending: setPushPending,
      getSubscription: function () { return Promise.resolve(sub); },
      subscribe: function (keyBytes) {
        return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes });
      },
      unsubscribe: function (s) { return s.unsubscribe(); },
      saveSubscription: postSubscription,
      dropSubscription: postUnsubscribe,
      log: pushLog
    }).then(function (r) {
      if (!r) return r;
      if (r.action === 'healed') {
        if (bell) bell.style.display = 'none';
        pushLog('warn', 'the platform push key changed; this device re-subscribed automatically');
      } else if (r.recoverable && bell) {
        bell.style.display = '';   // always leave a one-click manual path visible
      }
      return r;
    });
  }

  function updateBellVisibility() {
    var bell = document.querySelector('.p86-bgt-bell'); if (!bell) return;
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return;
    if (Notification.permission === 'denied') return;
    fetch('/api/push/public-key', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d || !d.configured || !d.key) return;   // VAPID not set yet — stay hidden
        navigator.serviceWorker.ready.then(function (reg) {
          return reg.pushManager.getSubscription().then(function (sub) {
            if (!sub) bell.style.display = '';       // configured + not subscribed → show
            // Reuses the key and the subscription fetched just above; adds no
            // request of its own on a device whose key already matches.
            return runPushRecovery(reg, sub, d.key, bell);
          });
        }).catch(function (e) { pushLog('warn', 'bell/recovery pass failed', e); });
      }).catch(function () {});
  }
  function enablePush() {
    var bell = document.querySelector('.p86-bgt-bell');
    Notification.requestPermission().then(function (perm) {
      if (perm !== 'granted') return;
      return fetch('/api/push/public-key', { credentials: 'same-origin' })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (!d || !d.key) return null;
          return navigator.serviceWorker.ready.then(function (reg) {
            // Clear a stale subscription BEFORE subscribing. subscribe() rejects
            // with InvalidStateError while one minted against a different
            // applicationServerKey is held, which is what made this button
            // useless after a rotation. Doing it here — and not in the
            // background reconcile — is the point: an explicit click is what
            // authorizes discarding a subscription we cannot prove is stale,
            // which covers the engines that never expose `options` at all.
            return reg.pushManager.getSubscription().then(function (old) {
              if (!old || keyState(old.options, d.key) === 'match') return old ? old.endpoint : null;
              setPushPending(true);
              return old.unsubscribe().then(function () { return old.endpoint; },
                function (e) { pushLog('warn', 'could not clear the stale subscription', e); return old.endpoint; });
            }).then(function (oldEndpoint) {
              return reg.pushManager
                .subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToU8(d.key) })
                .then(function (sub) { return { sub: sub, oldEndpoint: oldEndpoint }; });
            });
          });
        })
        .then(function (out) {
          if (!out || !out.sub) return;
          return postSubscription(out.sub.toJSON()).then(function () {
            setPushPending(false);
            if (out.oldEndpoint && out.oldEndpoint !== out.sub.endpoint) {
              postUnsubscribe(out.oldEndpoint).then(null, function (e) {
                pushLog('warn', 'stale subscription row not dropped for ' + out.oldEndpoint, e);
              });
            }
            if (bell) { bell.textContent = '🔔 Notifications on'; setTimeout(function () { bell.style.display = 'none'; }, 1800); }
          });
        })
        // NOT an empty catch. The previous one swallowed the InvalidStateError
        // that pushManager.subscribe() throws when a subscription minted with a
        // different applicationServerKey is still held — which is exactly why a
        // key rotation was invisible to everyone. Failures are now visible in
        // the console and on the button.
        .catch(function (e) {
          pushLog('error', 'enabling notifications failed', e);
          if (bell) { bell.textContent = '🔔 Couldn\'t enable — try again'; bell.style.display = ''; }
        });
    }).catch(function (e) { pushLog('error', 'notification permission request failed', e); });
  }

  function submitAnswerFor(jid, listEl) {
    var input = listEl.querySelector('.p86-bgt-answer-in[data-jid="' + jid + '"]');
    if (!input) return;
    var val = String(input.value || '').trim();
    if (!val) { input.focus(); return; }
    input.disabled = true;
    apiPost('/' + encodeURIComponent(jid) + '/answer', { answer: val })
      .then(function () { refresh(); })
      .catch(function () { input.disabled = false; });
  }

  function refresh() {
    if (document.hidden) return Promise.resolve();
    return apiGet('?limit=30').then(function (d) {
      _jobs = (d && d.jobs) || [];
      _attention = (d && d.attention) || 0;
      ensureDom();
      renderLauncher();
      if (_panelOpen) { renderPanel(); renderScribe(); }
    }).catch(function () { /* not authed / offline — stay quiet */ });
  }

  // "Scribe drafts" section — the crew's write work (payloads), so the panel is a
  // one-stop crew-activity summary: tasks above, drafts below.
  function renderScribe() {
    var host = document.querySelector('.p86-bgt-scribe'); if (!host) return;
    fetch('/api/payloads?limit=8', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        var rows = (d && d.payloads) || [];
        if (!rows.length) { host.innerHTML = ''; return; }
        var sMeta = function (s) {
          if (s === 'applied') return { label: 'Applied', color: '#34d399' };
          if (s === 'rejected') return { label: 'Rejected', color: '#8b90a5' };
          if (s === 'apply_failed' || s === 'failed') return { label: 'Failed', color: '#f87171' };
          // In-flight apply claim — NOT awaiting review, which is what the
          // fallback below would have called it.
          if (s === 'applying') return { label: 'Applying…', color: '#60a5fa' };
          return { label: 'Awaiting review', color: '#fbbf24' };
        };
        host.innerHTML =
          '<div style="padding:4px 14px 2px;color:#8b90a5;font:700 11px/1 system-ui,sans-serif;letter-spacing:.4px;text-transform:uppercase">Scribe drafts</div>' +
          '<div style="padding:4px 8px 10px">' +
          rows.map(function (p) {
            var m = sMeta(p.status);
            // Clicking a draft goes to the Writes ledger, where the same row
            // has its diff and (when it is still pending) its Approve button.
            // This popover is a glance; Cowork is the place you act.
            return '<div class="p86-bgt-item p86-bgt-draft" data-cwopen="' + esc(p.id) + '" ' +
              'role="button" tabindex="0" title="Open in Cowork">' +
              '<div class="p86-bgt-t"><span>' + esc(p.title || p.id) + '</span>' +
              '<span class="p86-bgt-pill" style="background:' + m.color + '22;color:' + m.color + '">' + esc(m.label) + '</span></div>' +
              (p.apply_summary || p.summary ? '<div class="p86-bgt-body">' + esc(String(p.apply_summary || p.summary).slice(0, 140)) + '</div>' : '') +
              '</div>';
          }).join('') + '</div>';
        // Delegated once per render — the list is rebuilt wholesale on refresh.
        host.onclick = function (e) {
          var it = e.target && e.target.closest && e.target.closest('[data-cwopen]');
          if (!it) return;
          var id = it.getAttribute('data-cwopen');
          try { if (typeof close === 'function') close(); } catch (_) {}
          try {
            if (window.p86Cowork && window.p86Cowork.open) window.p86Cowork.open(id);
            else if (window.switchTab) window.switchTab('cowork');
          } catch (err) { console.warn('[agent-tasks] open in Cowork failed', err); }
        };
      })
      .catch(function () { host.innerHTML = ''; });
  }

  function markAllSeen() {
    _jobs.filter(function (j) { return !j.seen_at && (j.status === 'done' || j.status === 'needs_input' || j.status === 'failed'); })
      .forEach(function (j) { apiPost('/' + encodeURIComponent(j.id) + '/seen', {}).catch(function () {}); });
    _attention = 0; renderLauncher();
  }

  function open() {
    ensureDom();
    _panelOpen = true;
    document.querySelector('.p86-bgt-overlay').classList.add('on');
    renderPanel();
    renderScribe();
    markAllSeen();
    refresh();
  }
  function close() {
    _panelOpen = false;
    var ov = document.querySelector('.p86-bgt-overlay'); if (ov) ov.classList.remove('on');
  }

  function start() {
    if (_timer) return;
    // Mount the pill immediately — refresh() skips hidden tabs and its API call
    // can fail, and neither should leave the panel unreachable.
    ensureDom();
    renderLauncher();
    refresh();
    _timer = setInterval(refresh, POLL_MS);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) refresh(); });
  }

  window.p86AgentTasks = { open: open, close: close, refresh: refresh };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
