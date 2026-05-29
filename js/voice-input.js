// Shared Web Speech API helper. Used by:
//   - js/ai-panel.js (86 chat composer mic)
//   - js/projects.js (walkthrough upload preview caption mic)
//
// One implementation, one set of mobile-quirks defenses. Earlier the
// two surfaces each had their own copy of the algorithm — they drifted
// (different silence timeouts, different cleanup paths), and the
// "double-speak" bug surfaced on the walkthrough because subtle
// edge-case defenses lived in the chat copy but not the walkthrough.
//
// Surface:
//   window.p86VoiceInput.wire(textareaEl, micBtnEl, opts)
//       Wires a mic button to a textarea. Returns a teardown
//       function the caller can invoke when the host UI closes.
//       opts: {
//         silenceTimeoutMs?: number   default 3000 (chat) — pass 5000
//                                     for walkthrough narration.
//         onChange?: function(value)  fired after each transcript
//                                     update so callers can sync
//                                     external state.
//       }
//   window.p86VoiceInput.isSupported()
//       Returns true if SpeechRecognition (native or webkit-prefixed)
//       exists. Callers should hide their mic UI when false.
//
// Algorithm: ARCHAEOLOGY-DRIVEN REVERT to Version A.
//
// The chat composer's original pre-consolidation inline mic (in
// js/ai-panel.js at commit 80705bb^) used a naive full-rescan
// approach with no dedup — and the user reports that version worked
// cleanly on his phone during real walkthroughs. Three subsequent
// "improvements" (the consolidation's iOS adjacent-final dedup, the
// engine-restart baseValue fix, and the index-tracked algorithm)
// each tried to solve a theoretical mobile-engine quirk and each
// left residual doubling behind. The empirical conclusion: the
// theoretical quirks aren't happening for John in practice, and
// every defense layered on top of A was solving phantoms while
// adding new edge cases.
//
// So we're back to Version A:
//
//   onresult(e) {
//     var allFinal = '', allInterim = '';
//     for (var i = 0; i < e.results.length; i++) {
//       if (e.results[i].isFinal) allFinal += transcript;
//       else allInterim += transcript;
//     }
//     textarea.value = baseValue + allFinal + allInterim;
//   }
//
// Why this is idempotent: every onresult event rebuilds allFinal +
// allInterim from scratch and replaces textarea.value entirely.
// Same e.results in → same string out. No state accumulates across
// events (allFinal is a fresh local var per call). The only thing
// that persists between events is baseValue (the textarea content
// at session start) — captured in onstart so a "send between
// dictations" cleanly clears the baseline.
//
// What we kept from the consolidation, because they're not algorithm
// behavior:
//   - The wire(textarea, button, opts) wrapper so chat + walkthrough
//     share one implementation
//   - Silence watchdog that stops the mic after N ms of quiet
//   - Optional onChange callback (no consumer uses it yet — kept
//     for API stability)
//
// Diagnostic: set window._p86VoiceDebug = true in devtools and the
// helper will log every e.results snapshot + the resolved textarea
// value to console. If a doubling pattern reappears, the log will
// show the actual engine emission so the next fix can be targeted
// at a real quirk instead of speculation.
(function () {
  'use strict';

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

    var recognition = null;
    var listening = false;
    var silenceTimer = null;
    var lastResultTs = 0;

    function setListening(v) {
      listening = v;
      micBtnEl.classList.toggle('listening', v);
      micBtnEl.title = v ? 'Stop dictation' : 'Dictate (voice → text)';
    }

    function stop() {
      if (silenceTimer) { clearInterval(silenceTimer); silenceTimer = null; }
      if (recognition) {
        try { recognition.stop(); } catch (e) {}
        recognition = null;
      }
      setListening(false);
    }

    function start() {
      try {
        recognition = new SR();
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.lang = navigator.language || 'en-US';
        // baseValue captured fresh on each onstart. This mirrors the
        // original chat-composer inline algorithm (pre-consolidation,
        // pre-80705bb) that was empirically known to work on John's
        // mobile setup. Re-capturing in onstart correctly handles the
        // "user sent the chat between dictations" case — the new
        // session starts from the now-empty textarea instead of
        // baselining onto stale pre-send text.
        var baseValue = '';
        recognition.onstart = function () {
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
          // Reset the silence countdown on every result (interim too)
          // so the mic stays open while mid-sentence.
          lastResultTs = Date.now();
          // Iterate the FULL e.results array, not e.resultIndex onward.
          // Mobile Safari + Chrome on Android don't advance
          // resultIndex reliably — reconstructing from scratch is
          // idempotent: no matter how many times this fires for the
          // same logical utterance, input.value lands at the right
          // text. Same-content re-emission writes the same string
          // and is a no-op effectively.
          var allFinal = '';
          var allInterim = '';
          for (var i = 0; i < e.results.length; i++) {
            var t = (e.results[i][0] && e.results[i][0].transcript) || '';
            if (e.results[i].isFinal) allFinal += t;
            else allInterim += t;
          }
          var nextValue = baseValue + allFinal + allInterim;

          // Diagnostic — set window._p86VoiceDebug = true in devtools
          // to log every e.results snapshot + the resolved value. Use
          // when a mobile quirk surfaces so the fix can be driven by
          // a real transcript instead of speculation.
          if (window._p86VoiceDebug) {
            try {
              var raw = [];
              for (var d = 0; d < e.results.length; d++) {
                raw.push((e.results[d].isFinal ? 'F:' : 'I:') +
                         JSON.stringify(e.results[d][0].transcript));
              }
              console.log('[voice] results(' + e.results.length + '):', raw.join(' '));
              console.log('[voice] → ' + JSON.stringify(nextValue));
            } catch (_) { /* defensive */ }
          }

          // Write unconditionally + use a NON-BUBBLING input event
          // to match the original chat-composer behavior exactly
          // (Version A — empirically known to work on John's phone).
          // A bubbling event could reach a parent listener and trip
          // an unknown side-effect path; the original used
          // `new Event('input')` (bubbles defaults to false) and
          // never had this class of bug.
          textareaEl.value = nextValue;
          try { textareaEl.dispatchEvent(new Event('input')); }
          catch (_) { /* defensive — older browsers may throw */ }
          if (onChange) {
            try { onChange(nextValue); } catch (_) { /* defensive */ }
          }
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
        alert('Could not start dictation: ' + (e.message || e));
        stop();
      }
    }

    micBtnEl.addEventListener('click', function (e) {
      e.preventDefault();
      if (listening) stop();
      else start();
    });

    // Teardown returned to caller so a closing modal / panel can
    // cleanly stop dictation. Idempotent — safe to call multiple times.
    return stop;
  }

  window.p86VoiceInput = {
    isSupported: isSupported,
    wire: wire
  };
})();
