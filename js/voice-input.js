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
//   1. Index-tracked finals (committedFinals[resultIndex] = transcript).
//      The Web Speech API gives each SpeechRecognitionResult a stable
//      position in e.results. Mobile engines have three documented
//      quirks the spec doesn't acknowledge but real browsers exhibit:
//        a. Same-index re-emission — every onresult re-sends the same
//           result at the same index (idempotent when index-tracked).
//        b. Whole-buffer re-emission — Android Chrome silently
//           restarts the mic stream when the network blips. The
//           restart re-emits the WHOLE buffer at higher indices —
//           [F:"hello", F:"world"] becomes [F:"hello", F:"world",
//           F:"hello", F:"world"]. Adjacent-only dedup misses this
//           because the two "hello"s are separated by a "world".
//           Indexing by position can't help with the doubled tail,
//           so we add an adjacent-byte-equal safety net below it.
//        c. Index-shrink on restart — some restarts trim the array
//           back, then grow it again. We trim committedFinals to
//           e.results.length on each tick so stale entries don't
//           re-append.
//   2. Consecutive-duplicate final de-dupe (safety net) — iOS in
//      particular can classify a single utterance as two separate
//      final results with identical transcripts at adjacent indices.
//      Drop a final if its trimmed transcript byte-equals the
//      previous pushed final's. True user-repetition usually arrives
//      with different transcripts (timing, punctuation, casing) so
//      this is safe in practice.
//   3. baseValue captured ONCE per user tap (not per onstart). Android
//      Chrome silently re-fires onstart when the engine restarts
//      mid-session — re-reading the textarea then would baseline
//      onto already-dictated text and the next onresult would append
//      on top, doubling. Captured in start() before recognition.start()
//      and never touched again.
//   4. Silence watchdog — Web Speech's continuous:true keeps the
//      mic open across pauses. UX-wise we stop after N ms of no
//      new results so users don't have to remember to toggle off.
//   5. Idempotent textarea write — if the recomputed value equals
//      the textarea's current value, skip the write + input event.
//      Avoids triggering autoGrow / autosave listeners on no-op
//      ticks and keeps the cursor stable.
//
// Diagnostic: set window._p86VoiceDebug = true in devtools and the
// helper will log every e.results snapshot + the resolved textarea
// value to console. Use when a NEW mobile quirk surfaces so the
// fix can be driven by a real transcript instead of speculation.
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
        // baseValue captured ONCE per user click — see header comment
        // (defense #3). Engine restarts re-fire onstart; we ignore
        // them there.
        var baseValue = textareaEl.value || '';
        if (baseValue && !/\s$/.test(baseValue)) baseValue += ' ';

        // committedFinals[i] = transcript of the SpeechRecognitionResult
        // at index i. Sparse array keyed by result-list position, NOT
        // a flat list of pushed entries. This is the core of the
        // dedup defense — see header comment (#1).
        var committedFinals = [];

        recognition.onstart = function () {
          // Don't touch baseValue or committedFinals here — see
          // header comment. Only update listening state + reset
          // the silence watchdog.
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

          // If the engine restarted and shrank e.results, drop the
          // stale tail so it doesn't re-append on the next paint.
          if (committedFinals.length > e.results.length) {
            committedFinals.length = e.results.length;
          }

          // Single pass: write final transcripts into their index
          // slot (idempotent — same transcript at same index is a
          // no-op; engine-corrected text replaces in place); collect
          // interims into a parallel sparse array.
          var interimByIndex = [];
          for (var i = 0; i < e.results.length; i++) {
            var t = (e.results[i][0] && e.results[i][0].transcript) || '';
            if (e.results[i].isFinal) {
              committedFinals[i] = t;
            } else if (t) {
              interimByIndex[i] = t;
            }
          }

          // Compose finals with adjacent-byte-equal safety net.
          // Whole-buffer re-emissions land repeated content at NEW
          // indices ([..., F:"hello", F:"world", F:"hello", F:"world"])
          // — the indexed memo can't catch that on its own because
          // each index is its own slot. The adjacent-equal check
          // catches the doubled tail because the re-emitted "hello"
          // immediately follows the original "world" in iteration
          // order and byte-equals the engine's prior emission — but
          // ONLY when the re-emission is byte-equal, which is the
          // engine-artifact signature. Legit repetition ("very very
          // nice") usually differs in transcript metadata.
          var finalsText = '';
          var lastPushed = '';
          for (var j = 0; j < committedFinals.length; j++) {
            var cf = committedFinals[j] || '';
            if (!cf) continue;
            var trimmed = cf.trim();
            if (trimmed && trimmed === lastPushed.trim()) continue;
            finalsText += cf;
            lastPushed = cf;
          }

          // Concat interims in index order — typically just one
          // (the trailing in-progress utterance), but a sparse fill
          // is handled gracefully.
          var interimText = '';
          for (var k = 0; k < interimByIndex.length; k++) {
            if (interimByIndex[k]) interimText += interimByIndex[k];
          }

          var nextValue = baseValue + finalsText + interimText;

          // Diagnostic — see header comment. Enable from devtools
          // with `window._p86VoiceDebug = true`.
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

          // Idempotent write — skip the input event when nothing
          // changed (avoids redundant autosave/autoGrow ticks and
          // keeps the cursor stable on no-op re-emissions).
          if (nextValue === textareaEl.value) return;
          textareaEl.value = nextValue;
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
