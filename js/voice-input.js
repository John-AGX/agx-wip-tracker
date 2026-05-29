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
// Mobile-specific defenses baked in:
//   1. Full e.results rescan on every onresult — mobile Safari /
//      Chrome on Android sometimes deliver the same final transcript
//      across multiple events without advancing e.resultIndex. The
//      rescan is idempotent: no matter how many times an utterance
//      re-fires, the input.value lands at the right text.
//   2. Consecutive-duplicate final de-dupe — iOS in particular can
//      classify a single utterance as two separate final results
//      with identical transcripts. We drop a final if its transcript
//      is byte-equal to the previous final's, which is the cheapest
//      heuristic that catches that case without dropping legit
//      doubled words ("very very nice" — the engine splits those
//      into different result entries with different timing metadata,
//      so adjacent text doesn't usually arrive byte-equal).
//   3. Silence watchdog — Web Speech's continuous:true keeps the
//      mic open across pauses. UX-wise we stop after N ms of no
//      new results so users don't have to remember to toggle off.
//   4. Reset baseline on each onstart — if the user sent the chat
//      between dictations, the new session captures the CURRENT
//      (post-send, empty) input value as its base, not the stale
//      pre-send one.
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
        // baseValue MUST be captured here, ONCE per user click — NOT
        // inside onstart. Android Chrome (and some iOS Safari builds)
        // silently restart the recognition engine mid-session during
        // continuous:true mode whenever there's a brief audio gap or
        // a network reconnect. Each restart re-fires onstart. If we
        // reset baseValue there, the second onstart captures the
        // already-dictated text as the new baseline, then the very
        // next onresult rebuilds `baseValue + finals + lastInterim`
        // — appending the in-flight finals onto a baseline that
        // ALREADY contained them. That's the residual "double speak"
        // the v1 dedup couldn't catch.
        var baseValue = textareaEl.value || '';
        if (baseValue && !/\s$/.test(baseValue)) baseValue += ' ';
        recognition.onstart = function () {
          // Don't touch baseValue here — see comment above. Only
          // update listening state + reset the silence watchdog.
          setListening(true);
          lastResultTs = Date.now();
          if (silenceTimer) clearInterval(silenceTimer);
          silenceTimer = setInterval(function () {
            if (!listening) return;
            if (Date.now() - lastResultTs > SILENCE_TIMEOUT_MS) stop();
          }, 500);
        };
        recognition.onresult = function (e) {
          lastResultTs = Date.now();
          // Full rescan + consecutive-duplicate de-dupe.
          //
          // Mobile Safari + Chrome on Android sometimes re-emit the
          // same interim phrase across multiple onresult events
          // without advancing e.resultIndex — which used to give us
          // "double speak" (the in-progress phrase appended onto
          // itself on every tick). Fix: take only the LATEST interim
          // for the trailing in-progress utterance, not the sum of
          // every interim across the whole results list. The earlier
          // interim entries have already been promoted to `isFinal`
          // (or replaced by their final form), so cumulatively adding
          // them re-says everything you've already said.
          //
          // Finals are still deduped against the immediate predecessor
          // (same iOS dup behavior on finalized utterances).
          var finals = [];
          var lastInterim = '';
          for (var i = 0; i < e.results.length; i++) {
            var t = (e.results[i][0] && e.results[i][0].transcript) || '';
            if (e.results[i].isFinal) {
              var trimmed = t.trim();
              if (trimmed && (!finals.length || finals[finals.length - 1].trim() !== trimmed)) {
                finals.push(t);
              }
              // Reset interim — once a final lands, any earlier
              // in-progress text for the same utterance is now stale.
              lastInterim = '';
            } else if (t) {
              // OVERWRITE, don't concatenate. The interim of the
              // trailing utterance replaces whatever the previous tick
              // had. If multiple non-final results show up in the same
              // event (rare but possible), the last one wins because
              // it's the most recently spoken.
              lastInterim = t;
            }
          }
          var nextValue = baseValue + finals.join('') + lastInterim;
          textareaEl.value = nextValue;
          // Surface a native input event so framework listeners (the
          // chat composer's debouncedSave equivalents) see the change.
          try { textareaEl.dispatchEvent(new Event('input', { bubbles: true })); }
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
