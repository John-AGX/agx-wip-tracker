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
    var silenceTimer = null;
    var lastResultTs = 0;

    function setListening(v) {
      listening = v;
      micBtnEl.classList.toggle('listening', v);
      micBtnEl.title = v ? 'Stop dictation' : 'Dictate (voice → text)';
    }

    function stop() {
      // Capture before teardown so onStop fires only when we were really
      // listening — and only once, even if a caller's onStop re-enters stop().
      var wasActive = !!(recognition || starting || listening);
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

    function start() {
      // Concurrent-start guard: bail if a recognizer is already running
      // or mid-start. Without this a fast double-tap (or a ghost click)
      // before onstart flips `listening` spins up a SECOND recognizer
      // writing into the same field — a real source of doubling.
      if (recognition || starting) return;
      starting = true;
      try {
        recognition = new SR();
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.lang = navigator.language || 'en-US';
        // baseValue captured fresh on each onstart so "send the chat
        // between dictations" baselines onto the now-empty textarea
        // instead of stale pre-send text.
        var baseValue = '';
        recognition.onstart = function () {
          starting = false;
          if (onStart) { try { onStart(); } catch (_) {} }
          baseValue = textareaEl.value || '';
          if (baseValue && !/\s$/.test(baseValue)) baseValue += ' ';
          setListening(true);
          lastResultTs = Date.now();
          if (silenceTimer) clearInterval(silenceTimer);
          silenceTimer = setInterval(function () {
            if (!listening) return;
            if (Date.now() - lastResultTs > SILENCE_TIMEOUT_MS) stop();
          }, 500);
        };
        recognition.onresult = function (e) {
          lastResultTs = Date.now();   // reset silence countdown (interim too)

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
        recognition.onerror = function (ev) {
          stop();
          if (ev && ev.error === 'not-allowed') {
            alert('Microphone access denied. Allow it in your browser settings to dictate.');
          }
        };
        recognition.onend = function () { stop(); };
        recognition.start();
      } catch (e) {
        starting = false;
        alert('Could not start dictation: ' + (e.message || e));
        stop();
      }
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
    };

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
