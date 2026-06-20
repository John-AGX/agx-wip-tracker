// Shared Web Speech text-to-SPEECH helper — the OUTPUT twin of
// js/voice-input.js. Used by js/ai-panel.js to read back a short
// confirmation when the Assistant / 86 creates an appointment, task,
// reminder, or itinerary (the "Siri-style" read-back).
//
// ── Why this is shaped the way it is (mobile-first, field crews) ────
//
// 1. iOS Safari only lets speechSynthesis.speak() produce audio when it
//    is "unlocked" from inside a real user gesture. A read-back fires
//    from the async p86:payload-applied event AFTER the Approve tap's
//    fetch resolves — i.e. OUTSIDE the gesture — so iOS silently drops
//    it. We mitigate by PRIMING (a near-silent utterance) on every
//    pointerdown, which unlocks the synth in-gesture. This is best
//    effort: the physical silent switch also mutes web speech and is
//    undetectable from JS. So auto-speak is NEVER the only signal —
//    the confirmation pill is always tappable to hear it on demand (an
//    in-gesture tap, which is 100% reliable on every platform).
//
// 2. The spoken string is financial-safe BY CONSTRUCTION. Voice turns a
//    glance-private screen into a jobsite announcement (crews, client,
//    GC in earshot). buildConfirmation() composes the line from the
//    write's entity_type (never free model text), and sanitizeForSpeech()
//    strips any dollar amount / percentage / bare entity-id as a final
//    guard. Dollar amounts, margins, and client financials are never
//    spoken in v1.
//
// 3. Engine is behind VOICE_ENGINE so a future natural cloud voice
//    (POST /api/tts -> <audio>) is a one-constant swap, not a rewrite.
//    Everything goes through p86VoiceOutput.speak — nothing else in the
//    app calls speechSynthesis directly.
//
// Surface:
//   window.p86VoiceOutput.speak(text, opts)   -> void  (sanitizes + speaks now)
//   window.p86VoiceOutput.cancel()            -> void
//   window.p86VoiceOutput.prime()             -> void  (unlock synth in-gesture)
//   window.p86VoiceOutput.isSupported()       -> boolean
//   window.p86VoiceOutput.isSpeaking()        -> boolean
//   window.p86VoiceOutput.isEnabled()         -> boolean (user read-back toggle)
//   window.p86VoiceOutput.setEnabled(bool)    -> void
//   window.p86VoiceOutput.buildConfirmation(detail) -> string (testable, safe)
//   window.p86VoiceOutput.setupReadback(panelEl)    -> void (wires the pill + listener)
//   window.p86VoiceOutLog()                   -> array of recent voice-out events
(function () {
  'use strict';

  // Engine seam. 'native' = on-device Web Speech (v1, free, no backend).
  // 'cloud' is reserved for a future POST /api/tts -> <audio> path
  // (natural neural voice); _speakCloud is stubbed below so flipping
  // this constant is the only change needed when that lands.
  var VOICE_ENGINE = 'native';

  var READBACK_KEY = 'p86VoiceReadback';   // '1' (default on) | '0'
  var FIRSTRUN_KEY = 'p86VoiceReadbackIntro';

  // Module-level capture ring buffer (mirrors voice-input.js's p86VoiceLog).
  var outLog = [];
  function logOut(entry) {
    try {
      entry.t = (window.performance && performance.now ? Math.round(performance.now()) : 0);
      outLog.push(entry);
      if (outLog.length > 30) outLog.shift();
      localStorage.setItem('p86VoiceOutLog', JSON.stringify(outLog));
      if (window._p86VoiceDebug) console.log('[voice-out]', JSON.stringify(entry));
    } catch (_) { /* private mode etc. */ }
  }

  function isSupported() {
    return !!(window.speechSynthesis && window.SpeechSynthesisUtterance);
  }

  // ── Voice selection ────────────────────────────────────────────────
  // getVoices() is empty on first call and populates async via the
  // 'voiceschanged' event; some Android WebViews never populate it. We
  // pick a preferred en-US voice once available, with a hard 1s timeout
  // fallback to the platform default (null) so we never hang waiting.
  var _voice = null;
  var _voicesReady = false;
  function pickVoice() {
    if (!isSupported()) return;
    var voices = [];
    try { voices = window.speechSynthesis.getVoices() || []; } catch (_) {}
    if (!voices.length) return;            // not populated yet
    _voicesReady = true;
    var en = voices.filter(function (v) { return /^en(-|_|$)/i.test(v.lang || ''); });
    var pool = en.length ? en : voices;
    // Prefer a natural-sounding system voice where one exists, else the
    // first en-US local voice, else whatever the platform defaults to.
    var preferred = ['Samantha', 'Google US English', 'Microsoft Aria', 'Microsoft Jenny', 'Karen', 'Daniel'];
    for (var p = 0; p < preferred.length; p++) {
      var hit = pool.filter(function (v) { return (v.name || '').indexOf(preferred[p]) === 0; })[0];
      if (hit) { _voice = hit; logOut({ ev: 'voice', name: _voice.name }); return; }
    }
    _voice = pool.filter(function (v) { return v.localService; })[0] || pool[0] || null;
    logOut({ ev: 'voice', name: _voice ? _voice.name : '(default)' });
  }
  if (isSupported()) {
    try { window.speechSynthesis.onvoiceschanged = pickVoice; } catch (_) {}
    pickVoice();
    // Hard fallback: if voices never populate (Android), proceed with the
    // platform default and record it so the silence is diagnosable.
    setTimeout(function () {
      if (!_voicesReady) logOut({ ev: 'voices_never_populated' });
    }, 1000);
  }

  // ── iOS gesture priming ────────────────────────────────────────────
  // _unlocked tracks whether the synth has been unlocked in-gesture this
  // foreground session. prime() speaks a near-silent space utterance to
  // unlock it; it's cheap + idempotent. visibilitychange->hidden re-locks
  // (iOS re-locks after backgrounding mid-speech), so we re-prime on the
  // next pointerdown.
  var _unlocked = false;
  function prime() {
    if (!isSupported() || _unlocked) return;
    try {
      var u = new SpeechSynthesisUtterance(' ');
      u.volume = 0; u.rate = 2;
      window.speechSynthesis.speak(u);
      _unlocked = true;
      logOut({ ev: 'primed' });
    } catch (_) { /* defensive */ }
  }

  // ── Financial-safety sanitizer ─────────────────────────────────────
  // Defense-in-depth: even though buildConfirmation composes from
  // entity_type (not free text), strip anything money-shaped or an
  // entity-id before it can be spoken aloud on a jobsite.
  function sanitizeForSpeech(s) {
    if (!s) return '';
    return String(s)
      .replace(/\$\s?\d[\d,]*(\.\d+)?/g, '')                       // $1,234.56
      .replace(/\b\d[\d,]*(\.\d+)?\s?(dollars?|usd)\b/gi, '')      // 4200 dollars
      .replace(/\b\d+(\.\d+)?\s?k\b/gi, '')                        // 4.2k
      .replace(/\b\d+(\.\d+)?\s?%/g, '')                           // 12%
      .replace(/\b\d+(\.\d+)?\s?percent\b/gi, '')                  // 12 percent
      .replace(/\b[a-z]\d{2,}\b/gi, '')                            // bare ids: j1778…, e23
      .replace(/\s{2,}/g, ' ')
      .replace(/\s+([.,!?])/g, '$1')
      .replace(/^[\s,;:–—-]+|[\s,;:–—-]+$/g, '')
      .trim();
  }

  // ── Build a safe spoken confirmation from a payload-applied detail ──
  // detail = { apply_summary, affected_targets:[{entity_type, entity_id,
  //            entity_display?, title?, label?}], ... }
  // v1: composes one short sentence from entity_type (+ an optional safe
  // display name). Richer "Thursday at 9 AM" specifics are a fast-follow
  // that needs a server-emitted meta.speak slot template — noted, not v1.
  var NOUNS = {
    schedule: 'appointment', appointment: 'appointment', event: 'appointment',
    task: 'task', reminder: 'reminder', lead: 'lead', client: 'client',
    estimate: 'estimate', job: 'job', change_order: 'change order',
    note: 'note', report: 'report'
  };
  var CREATE_VERB = { schedule: 'added', appointment: 'added', event: 'added',
    task: 'added', reminder: 'set', lead: 'created', client: 'added',
    estimate: 'created', note: 'saved', change_order: 'drafted', report: 'created' };

  function safeDisplay(t) {
    var d = t && (t.entity_display || t.title || t.label);
    if (!d) return '';
    d = sanitizeForSpeech(d);
    // keep it short + name-like; drop anything that became empty/numeric
    if (!d || d.length > 40 || /^\d+$/.test(d)) return '';
    return d;
  }

  function buildConfirmation(detail) {
    detail = detail || {};
    var targets = detail.affected_targets || [];
    var summary = (detail.apply_summary || '').toLowerCase();

    // Determine the dominant entity type.
    var type = '';
    for (var i = 0; i < targets.length; i++) {
      var et = targets[i] && targets[i].entity_type;
      if (et && NOUNS[et]) { type = et; break; }
    }
    // apply_summary often signals a note append on a job/lead.
    if (!type && /note\(s\)?/.test(summary)) type = 'note';
    if (!type && targets[0] && targets[0].entity_type) type = targets[0].entity_type;

    var noun = NOUNS[type] || (type ? type.replace(/_/g, ' ') : 'change');
    var verb = CREATE_VERB[type] || 'updated';
    var display = targets.length === 1 ? safeDisplay(targets[0]) : '';

    var line;
    if (targets.length > 1 && type) {
      line = 'Got it — ' + targets.length + ' ' + noun + 's ' + verb + '.';
    } else if (type === 'reminder') {
      line = "Got it — reminder " + verb + (display ? ' for ' + display : '') + '.';
    } else {
      line = 'Got it — ' + noun + ' ' + verb + (display ? ' for ' + display : '') + '.';
    }
    return sanitizeForSpeech(line);
  }

  // ── Speaking ───────────────────────────────────────────────────────
  var _speaking = false;
  var _onState = null;   // callback(state) wired by setupReadback for the pill
  function setState(s) { _speaking = (s === 'speaking'); if (_onState) { try { _onState(s); } catch (_) {} } }

  function _speakNative(text) {
    try {
      // Clear any stuck queue (an iOS quirk) before the real utterance.
      window.speechSynthesis.cancel();
      var u = new SpeechSynthesisUtterance(text);
      if (_voice) u.voice = _voice;
      u.rate = 1.0; u.pitch = 1.0; u.volume = 1.0;
      u.onstart = function () { setState('speaking'); };
      u.onend = function () { setState('idle'); };
      u.onerror = function (e) { setState('idle'); logOut({ ev: 'error', err: (e && e.error) || '?' }); };
      window.speechSynthesis.speak(u);
      logOut({ ev: 'speak', text: text, unlocked: _unlocked, voice: _voice ? _voice.name : '(default)' });
    } catch (e) {
      setState('idle');
      logOut({ ev: 'speak_throw', msg: String(e && e.message || e) });
    }
  }

  // Reserved for VOICE_ENGINE === 'cloud'. Contract (when wired):
  // POST /api/tts {text} -> audio/mpeg (key server-side, RBAC-gated,
  // rate-limited). Play via a primed <audio> element. Falls back to
  // native until that route exists.
  function _speakCloud(text) {
    logOut({ ev: 'cloud_fallback' });
    _speakNative(text);
  }

  function _emit(text) {
    if (VOICE_ENGINE === 'cloud') _speakCloud(text);
    else _speakNative(text);
  }

  // Confirmation read-back — financial-safe (sanitizeForSpeech strips $/%/ids).
  function speak(text, opts) {
    if (!isSupported()) return;
    var clean = sanitizeForSpeech(text);
    if (!clean) return;
    _emit(clean);
  }

  // Voice-chat reply — speaks the assistant's full answer aloud, NUMBERS
  // INCLUDED (the user opted into voice mode with an earshot warning).
  // cleanForSpeech strips markdown + caps length but keeps the figures.
  function speakReply(text) {
    if (!isSupported()) return;
    var clean = cleanForSpeech(text);
    if (!clean) return;
    _emit(clean);
  }

  // Make a long/markdown reply speakable: strip formatting + cap length.
  // Deliberately does NOT remove numbers — voice-chat wants the figures.
  function cleanForSpeech(s) {
    if (!s) return '';
    var t = String(s)
      .replace(/```[\s\S]*?```/g, ' ')                // code fences
      .replace(/`([^`]*)`/g, '$1')                    // inline code
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')      // links/images -> text
      .replace(/^\s{0,3}#{1,6}\s*/gm, '')             // headings
      .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, '$1')   // bold / italic
      .replace(/^\s{0,3}>\s?/gm, '')                  // blockquotes
      .replace(/^\s*[-*+]\s+/gm, '')                  // bullets
      .replace(/\|/g, ' ')                            // table pipes
      .replace(/https?:\/\/\S+/g, '')                 // bare urls
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (t.length > 360) {                              // don't monologue
      var cut = t.slice(0, 360);
      var dot = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
      t = (dot > 120 ? cut.slice(0, dot + 1) : cut) + ' … the rest is on your screen.';
    }
    return t;
  }

  function cancel() {
    if (!isSupported()) return;
    try { window.speechSynthesis.cancel(); } catch (_) {}
    setState('idle');
  }

  function isSpeaking() { return _speaking; }

  // ── User toggle ────────────────────────────────────────────────────
  function isEnabled() {
    try { return localStorage.getItem(READBACK_KEY) !== '0'; } catch (_) { return true; }
  }
  function setEnabled(v) {
    try { localStorage.setItem(READBACK_KEY, v ? '1' : '0'); } catch (_) {}
  }

  // ── Voice-chat mode ────────────────────────────────────────────────
  // Session-scoped (never persisted, so the mic is never hot across
  // reloads without an explicit tap). When ON, ai-panel auto-submits a
  // finished dictation and speaks the assistant's full reply aloud.
  var _voiceMode = false;
  function isVoiceMode() { return _voiceMode; }
  function setVoiceMode(v) { _voiceMode = !!v; }

  // ── Read-back wiring + confirmation pill ───────────────────────────
  // Called once from ai-panel.js after setupVoiceInput. Wires: a global
  // pointerdown primer (unlock the synth in-gesture), the
  // p86:payload-applied listener (speak the safe confirmation), and a
  // small floating pill that (a) shows the spoken line, (b) is tappable
  // to (re)hear it — the guaranteed-reliable in-gesture path — and (c)
  // doubles as the stop/mute control.
  var _wired = false;
  var _pill = null, _pillText = null, _lastLine = '';
  function setupReadback(panelEl) {
    if (_wired || !isSupported()) return;
    _wired = true;

    // Prime on every pointerdown (cheap, idempotent, in-gesture). Capture
    // phase so it runs before app handlers. Re-lock on background.
    document.addEventListener('pointerdown', prime, true);
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) _unlocked = false;
    });

    buildPill(panelEl || document.body);
    setupVoiceChat(panelEl);

    document.addEventListener('p86:payload-applied', function (ev) {
      try {
        if (!isEnabled()) return;
        var line = buildConfirmation((ev && ev.detail) || {});
        if (!line) return;
        _lastLine = line;
        showPill(line);
        maybeFirstRunNote();
        // Auto-speak only when foreground; never into a hidden tab.
        if (!document.hidden) speak(line);
      } catch (e) { logOut({ ev: 'readback_throw', msg: String(e && e.message || e) }); }
    });
  }

  function buildPill(host) {
    if (_pill) return;
    var p = document.createElement('div');
    p.id = 'p86-voice-pill';
    p.setAttribute('role', 'status');
    p.style.cssText =
      'position:fixed;left:50%;bottom:84px;transform:translateX(-50%);z-index:99998;' +
      'display:none;align-items:center;gap:8px;max-width:min(86vw,420px);' +
      'padding:9px 12px;border-radius:22px;cursor:pointer;' +
      'background:rgba(20,24,32,0.94);color:#e8eef7;font:500 13px/1.3 -apple-system,Segoe UI,Roboto,sans-serif;' +
      'box-shadow:0 6px 24px rgba(0,0,0,0.4);border:1px solid rgba(255,255,255,0.12);' +
      '-webkit-tap-highlight-color:transparent;user-select:none;';
    var spk = document.createElement('span');
    spk.id = 'p86-voice-pill-icon';
    spk.style.cssText = 'font-size:16px;min-width:20px;text-align:center;';
    spk.textContent = '🔊';
    var txt = document.createElement('span');
    txt.id = 'p86-voice-pill-text';
    txt.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    var mute = document.createElement('span');
    mute.title = 'Mute read-backs';
    mute.style.cssText = 'margin-left:4px;font-size:13px;opacity:0.6;min-width:44px;text-align:right;padding-left:6px;';
    mute.textContent = 'Mute';
    p.appendChild(spk); p.appendChild(txt); p.appendChild(mute);

    // Tap the body of the pill = (re)hear it in-gesture (always reliable),
    // or stop if currently speaking.
    p.addEventListener('click', function (e) {
      if (e.target === mute) {
        setEnabled(false); cancel(); hidePill();
        return;
      }
      if (isSpeaking()) { cancel(); }
      else { prime(); speak(_lastLine); }
    });

    // Reflect speaking state on the icon.
    _onState = function (s) {
      if (!_pill) return;
      spk.textContent = (s === 'speaking') ? '⏹' : '🔊';
    };

    (host || document.body).appendChild(p);
    _pill = p; _pillText = txt;
  }

  var _hideTimer = null;
  function showPill(line) {
    if (!_pill) return;
    _pillText.textContent = line;
    _pill.style.display = 'flex';
    if (_hideTimer) clearTimeout(_hideTimer);
    // Auto-hide after a bit; stays long enough to tap-to-hear if auto
    // audio was blocked (iOS) — it's the guaranteed manual path.
    _hideTimer = setTimeout(hidePill, 9000);
  }
  function hidePill() {
    if (_pill) _pill.style.display = 'none';
    if (_hideTimer) { clearTimeout(_hideTimer); _hideTimer = null; }
  }

  // One-time, non-blocking note so audio is never a surprise.
  function maybeFirstRunNote() {
    try {
      if (localStorage.getItem(FIRSTRUN_KEY) === '1') return;
      localStorage.setItem(FIRSTRUN_KEY, '1');
      // First time only: keep the real confirmation, append a mute hint
      // so audio is never a surprise without clobbering the message.
      if (_pillText) _pillText.textContent += '  ·  tap Mute to silence';
    } catch (_) {}
  }

  // Inject a voice-chat toggle (headset) beside the composer mic. Tapping
  // it flips voice mode: ai-panel then auto-submits a finished dictation
  // and speaks 86/Assistant's reply aloud. PTT — you tap the mic each turn.
  var CHAT_INTRO_KEY = 'p86VoiceChatIntro';
  function setupVoiceChat(panelEl) {
    try {
      var mic = (panelEl && panelEl.querySelector) ? panelEl.querySelector('#ai-mic') : null;
      if (!mic || !mic.parentNode || mic.parentNode.querySelector('#p86-voice-mode')) return;
      var btn = document.createElement('button');
      btn.id = 'p86-voice-mode';
      btn.type = 'button';
      btn.title = 'Voice chat — talk to 86, hear the reply';
      btn.setAttribute('aria-label', 'Voice chat mode');
      btn.className = mic.className || 'ai-tool-btn';
      btn.style.cssText = 'font-size:17px;';
      btn.textContent = '🎧';
      mic.parentNode.insertBefore(btn, mic.nextSibling);
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        var on = !isVoiceMode();
        setVoiceMode(on);
        btn.style.background = on ? 'rgba(79,140,255,0.30)' : '';
        btn.style.color = on ? '#9ec5ff' : '';
        btn.title = on ? 'Voice chat ON — tap the mic to talk' : 'Voice chat — talk to 86, hear the reply';
        if (on) {
          prime();
          showPill(firstChatIntro() || 'Voice chat on — tap the mic to talk; I’ll reply out loud.');
        } else {
          cancel(); hidePill();
        }
      });
    } catch (_) {}
  }
  // One-time earshot warning the first time voice chat is turned on.
  function firstChatIntro() {
    try {
      if (localStorage.getItem(CHAT_INTRO_KEY) === '1') return null;
      localStorage.setItem(CHAT_INTRO_KEY, '1');
      return 'Voice chat on — I read replies aloud, dollar amounts included, so others nearby may hear them.';
    } catch (_) { return null; }
  }

  window.p86VoiceOutput = {
    speak: speak,
    speakReply: speakReply,
    cancel: cancel,
    prime: prime,
    isSupported: isSupported,
    isSpeaking: isSpeaking,
    isEnabled: isEnabled,
    setEnabled: setEnabled,
    isVoiceMode: isVoiceMode,
    setVoiceMode: setVoiceMode,
    buildConfirmation: buildConfirmation,
    sanitizeForSpeech: sanitizeForSpeech,
    cleanForSpeech: cleanForSpeech,
    setupReadback: setupReadback
  };
  window.p86VoiceOutLog = function () { return outLog.slice(); };
})();
