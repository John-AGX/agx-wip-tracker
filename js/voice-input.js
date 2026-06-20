// Shared Web Speech API helper. Used by:
//   - js/ai-panel.js (86 chat composer mic)
//   - js/projects.js (walkthrough upload preview caption mic)
//
// ── The "double-speak on mobile" bug — the real root cause ──────────
//
// History: the result algorithm was rewritten ~4 times (index-tracked,
// full-rescan "Version A", iOS adjacent-final dedup, engine-restart
// baseValue fix). Each tweaked the WRONG layer and the doubling kept
// coming back, because the cause is NOT the accumulation logic — it's
// that mobile Chrome/Safari with `continuous = true` RE-EMITS finalized
// phrases as EXTRA final results. e.results ends up holding more finals
// than there were spoken phrases — duplicates ("walls", "walls",
// "are cracked") or growing "extension" restatements ("walls",
// "walls are", "walls are cracked"). Any algorithm that concatenates
// every final (Version A's `allFinal += t`) then doubles. The previous
// revert DELETED the dedup that was compensating for this, on the
// assumption the quirk "wasn't happening" — it is.
//
// Fix (this version), defensive on every known doubling path:
//   1. onresult collapses adjacent finals that are exact duplicates or
//      prefix-extensions of each other. Genuinely separate segments
//      (not prefixes) pass through untouched, so normal dictation is
//      unchanged — only the engine's redundant re-emissions are dropped.
//   2. A concurrent-start guard: a fast double-tap before onstart flips
//      `listening` can no longer spin up a SECOND recognizer writing
//      into the same field.
//   3. Re-wiring the same button auto-drops the prior click handler (via
//      micBtnEl._p86VoiceUnbind) so listeners can't stack into multiple
//      recognizers. The returned teardown only STOPS dictation and leaves
//      the button usable — callers fire it on every send.
//   4. Always-on capture: every emission is recorded to a ring buffer
//      (window.p86VoiceLog(), mirrored to localStorage 'p86VoiceLog').
//      If doubling ever recurs, the exact engine emission is on record —
//      no mobile devtools needed. Set window._p86VoiceDebug for console.
//
// Surface:
//   window.p86VoiceInput.wire(textareaEl, micBtnEl, opts) -> teardown fn
//       opts: { silenceTimeoutMs?: number (default 3000),
//               onChange?: function(value) }
//   window.p86VoiceInput.isSupported() -> boolean
//   window.p86VoiceLog() -> array of recent { raw, finals, merged, value }
(function () {
  'use strict';

  // Module-level capture ring buffer (shared across all wired surfaces).
  var captureLog = [];
  function pushCapture(entry) {
    captureLog.push(entry);
    if (captureLog.length > 30) captureLog.shift();
    try { localStorage.setItem('p86VoiceLog', JSON.stringify(captureLog)); } catch (_) {}
  }

  function isSupported() {
    return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  }

  function wire(textareaEl, micBtnEl, opts) {
    if (!textareaEl || !micBtnEl) return function () {};
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      micBtnEl.style.display = 'none';
      return function () {};
    }
    opts = opts || {};
    var SILENCE_TIMEOUT_MS = opts.silenceTimeoutMs || 3000;
    // Max wait for the user to START talking after the mic opens (no result
    // at all). Distinct from SILENCE_TIMEOUT_MS, which is the pause-tolerance
    // AFTER speech begins. Keeps an auto-opened (voice-chat) mic from hanging
    // open forever while still giving the user time to begin. Default 20s.
    var NO_SPEECH_TIMEOUT_MS = opts.noSpeechTimeoutMs || 20000;
    var onChange = typeof opts.onChange === 'function' ? opts.onChange : null;
    // Fired when dictation actually starts — used to cancel any active
    // TTS read-back so the mic never hears (and transcribes) its own voice.
    var onStart = typeof opts.onStart === 'function' ? opts.onStart : null;
    // Fired once when dictation stops (silence/tap/end) — voice-chat uses
    // it to auto-submit the finished utterance.
    var onStop = typeof opts.onStop === 'function' ? opts.onStop : null;

    var recognition = null;
    var listening = false;
    var starting = false;       // true between start() and onstart — guards the double-tap race
    var stopping = false;       // stop() in progress — the recognizer's onend must NOT restart
    var silenceTimer = null;
    var lastResultTs = 0;
    var startTs = 0;
    var hadSpeech = false;       // flips true on the first result (interim or final)
    var baseValue = '';          // session-level so an engine auto-restart accumulates onto prior text

    function setListening(v) {
      listening = v;
      micBtnEl.classList.toggle('listening', v);
      micBtnEl.title = v ? 'Stop dictation' : 'Dictate (voice → text)';
    }

    function stop() {
      // Capture before teardown so onStop fires only when we were really
      // listening — and only once, even if a caller's onStop re-enters stop().
      var wasActive = !!(recognition || starting || listening);
      stopping = true;          // tells the recognizer's onend NOT to restart
      starting = false;
      if (silenceTimer) { clearInterval(silenceTimer); silenceTimer = null; }
      if (recognition) {
        try { recognition.stop(); } catch (e) {}
        recognition = null;
      }
      setListening(false);
      if (wasActive && onStop) { try { onStop(); } catch (_) {} }
    }

    // Collapse the mobile engine's redundant final re-emissions. Drops a
    // final that exactly duplicates the previous, and replaces the
    // previous with a longer "extension" restatement of it. Separate
    // (non-prefix) segments are kept as-is, so real speech is untouched.
    function mergeFinals(segs) {
      var out = [];
      for (var k = 0; k < segs.length; k++) {
        var s = segs[k];
        var st = s.replace(/^\s+|\s+$/g, '');
        if (!st) continue;
        if (out.length) {
          var pt = out[out.length - 1].replace(/^\s+|\s+$/g, '');
          if (st === pt) continue;                                  // exact duplicate
          if (st.indexOf(pt) === 0) { out[out.length - 1] = s; continue; } // extension → keep the longer
          if (pt.indexOf(st) === 0) { continue; }                   // shorter prefix of prev → drop
        }
        out.push(s);
      }
      return out;
    }

    // The watchdog is the AUTHORITY on when the session ends. The Web Speech
    // engine stops on its OWN after only a few seconds of silence (especially
    // on mobile) — we restart it (see spinUp's onend) and let THIS timer make
    // the real cutoff: NO_SPEECH_TIMEOUT_MS before any speech, then
    // SILENCE_TIMEOUT_MS after speech begins.
    function windowExpired() {
      var now = Date.now();
      return (!hadSpeech && now - startTs > NO_SPEECH_TIMEOUT_MS) ||
             (hadSpeech && now - lastResultTs > SILENCE_TIMEOUT_MS);
    }
    function startWatchdog() {
      if (silenceTimer) clearInterval(silenceTimer);
      silenceTimer = setInterval(function () {
        if (listening && windowExpired()) stop();
      }, 500);
    }

    // Create + start ONE recognizer for the current session. Re-invoked by
    // its own onend whenever the engine auto-stops on silence, so the mic
    // stays open across the engine's short internal timeout until the
    // watchdog (or the user) ends the session.
    function spinUp() {
      if (recognition) return;
      var rec;
      try { rec = new SR(); }
      catch (e) { starting = false; stop(); return; }
      recognition = rec;
      rec.continuous = true;
      rec.interimResults = true;
      rec.lang = navigator.language || 'en-US';
      rec.onstart = function () {
        starting = false;
        // Re-baseline onto whatever is already in the field so a restart
        // (or a send between dictations) accumulates instead of duplicating.
        baseValue = textareaEl.value || '';
        if (baseValue && !/\s$/.test(baseValue)) baseValue += ' ';
      };
      rec.onresult = function (e) {
        lastResultTs = Date.now();   // reset silence countdown (interim too)
        hadSpeech = true;            // switch the watchdog to post-speech mode

        // Rebuild from the full results array (resultIndex is
        // unreliable on mobile), then collapse redundant finals.
        var allInterim = '';
        var finalSegs = [];
        for (var i = 0; i < e.results.length; i++) {
          var t = (e.results[i][0] && e.results[i][0].transcript) || '';
          if (e.results[i].isFinal) finalSegs.push(t);
          else allInterim += t;
        }
        var merged = mergeFinals(finalSegs);
        var allFinal = merged.join('');   // direct concat preserves the engine's own spacing
        var nextValue = baseValue + allFinal + allInterim;

        // Always-on capture (cheap) — a recurrence is diagnosable with
        // no devtools via window.p86VoiceLog() / localStorage.
        try {
          var raw = [];
          for (var d = 0; d < e.results.length; d++) {
            raw.push((e.results[d].isFinal ? 'F:' : 'I:') +
                     ((e.results[d][0] && e.results[d][0].transcript) || ''));
          }
          pushCapture({ t: lastResultTs, raw: raw, finals: finalSegs.length, merged: merged.length, value: nextValue });
          if (window._p86VoiceDebug) {
            console.log('[voice] results(' + e.results.length + '):', raw.join(' '));
            console.log('[voice] finals ' + finalSegs.length + ' → merged ' + merged.length + ' → ' + JSON.stringify(nextValue));
          }
        } catch (_) { /* defensive */ }

        // Non-bubbling input event (matches the known-good original).
        textareaEl.value = nextValue;
        try { textareaEl.dispatchEvent(new Event('input')); }
        catch (_) { /* older browsers */ }
        if (onChange) { try { onChange(nextValue); } catch (_) {} }
      };
      rec.onerror = function (ev) {
        if (ev && ev.error === 'not-allowed') {
          stop();
          alert('Microphone access denied. Allow it in your browser settings to dictate.');
        }
        // Other errors (no-speech / aborted / network) fall through to onend,
        // which decides whether to restart or finalize.
      };
      rec.onend = function () {
        recognition = null;
        if (stopping || !listening) return;        // user/watchdog already ended it
        if (windowExpired()) { stop(); return; }   // listen window elapsed → done
        // Engine auto-ended but we're still inside the window — restart it
        // (paced, so a fast end/error can't tight-loop).
        starting = true;
        setTimeout(function () {
          if (!listening || stopping) { starting = false; return; }
          spinUp();
        }, 250);
      };
      try { rec.start(); }
      catch (e) { recognition = null; starting = false; stop(); }
    }

    function start() {
      // One session per tap. `listening` is set synchronously (via
      // setListening) so a fast double-tap can't open a second session.
      if (listening || starting) return;
      stopping = false;
      starting = true;
      startTs = Date.now();
      hadSpeech = false;
      lastResultTs = startTs;
      baseValue = '';
      setListening(true);
      if (onStart) { try { onStart(); } catch (_) {} }
      startWatchdog();
      spinUp();
    }

    // Re-wire guard: if this button was wired before (e.g. a panel rebuilt
    // in place), drop the prior click handler BEFORE adding a fresh one so
    // listeners can't stack into multiple recognizers. Done here — NOT in
    // the returned teardown — because callers fire the teardown on every
    // send to stop dictation, and the button must stay usable afterward.
    if (typeof micBtnEl._p86VoiceUnbind === 'function') {
      try { micBtnEl._p86VoiceUnbind(); } catch (_) {}
    }
    function onMicClick(e) {
      e.preventDefault();
      if (listening || starting) stop();
      else start();
    }
    micBtnEl.addEventListener('click', onMicClick);
    micBtnEl._p86VoiceUnbind = function () {
      try { micBtnEl.removeEventListener('click', onMicClick); } catch (_) {}
      micBtnEl._p86VoiceUnbind = null;
      micBtnEl._p86VoiceStart = null;
      micBtnEl._p86VoiceStop = null;
    };
    // Programmatic start/stop so voice-chat can drive the mic itself —
    // open it on entering voice mode and re-arm it after 86's spoken reply.
    // Idempotent: start() no-ops if already listening/starting.
    micBtnEl._p86VoiceStart = function () { if (!listening && !starting) start(); };
    micBtnEl._p86VoiceStop = function () { stop(); };
    micBtnEl._p86VoiceListening = function () { return listening || starting; };

    // The returned teardown STOPS dictation but leaves the click handler
    // bound — the chat composer calls it on every send and the mic must
    // keep working after. (Regression fix: it previously also unbound the
    // handler, which left the button dead after the first send.) To fully
    // unbind a button whose host is going away, call micBtnEl._p86VoiceUnbind().
    return stop;
  }

  window.p86VoiceInput = { isSupported: isSupported, wire: wire };
  // Diagnostic getter — the last ~30 raw engine emissions + collapsed
  // results. Survives in localStorage('p86VoiceLog') across reloads.
  window.p86VoiceLog = function () { return captureLog.slice(); };
})();
