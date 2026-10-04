/* ── The Queue ──────────────────────────────────────────────────────────
   One page for the decisions something is waiting on you for.

   THE IDEA IS A CONTINUATION, NOT A NOTIFICATION. Every item here belongs to
   a producer that stopped mid-work and parked a question. Answering does not
   file the item away — it restarts the producer. For the first producer, a
   background agent task, that is literally true: POST /api/agent-jobs/:id/
   answer writes pause_answer, and the worker's next tick (10s) claims the row
   and resumes the SAME live Anthropic session with the answer as one more
   user message (server/agent-jobs-worker.js, server/routes/ai-routes.js
   resumeAgentJob). Nothing is replayed and the agent keeps its context.

   That is also why this page can exist at all: resumption is driven by the
   worker polling the row, not by the chat the task came from. Answering from
   here is the same act as answering in the panel.

   SLICE 1 IS ONE PRODUCER AND ONE VERB. Background tasks, answered in free
   text. Approve/reject is deliberately absent: a background agent cannot
   propose a write today — the approval tier is refused outright for
   background runs (ai-routes.js makeBackgroundJobCallback) and proposed
   writes live in `payloads`, which Cowork owns. Adding a verb with no
   producer behind it would be a button that nothing can ever press.

   Producers to come (each an adapter, not a rewrite): the Buildertrend sync
   preview, Bulk Document Import, Cost Inbox. Those have their own rich
   review screens, so they belong here as ONE item that deep-links out, never
   as hundreds of cards.

   window.p86Queue.render(host)  — the page
   window.p86Queue.openItem(id)  — deep link /queue/:id
   window.p86Queue.pendingCount() — what the nav badge shows
   ──────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  var POLL_MS = 20000;
  var _host = null;
  var _jobs = [];
  var _loaded = false;
  var _error = null;
  var _busy = {};          // id -> true while an answer is in flight
  var _timer = null;
  var _focusId = null;     // deep-linked item, scrolled to once

  function api() { return window.p86Api; }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ── what is waiting ───────────────────────────────────────────────
  // A decision, not an event: a task that has asked and is holding. The
  // done/failed rows in the same feed are NOT queue items — they are history,
  // and they live under the fold so the top of the page is only ever work.
  function isWaiting(j) { return !!(j && j.status === 'needs_input' && j.pause_question); }
  function waiting() { return _jobs.filter(isWaiting); }
  function recent() {
    return _jobs.filter(function (j) { return !isWaiting(j); }).slice(0, 12);
  }
  function pendingCount() { return waiting().length; }

  // ── load ──────────────────────────────────────────────────────────
  function load() {
    if (!api() || typeof api().get !== 'function') {
      _error = 'Not signed in.';
      _loaded = true;
      return Promise.resolve();
    }
    return api().get('/api/agent-jobs?limit=50').then(function (d) {
      _jobs = (d && d.jobs) || [];
      _error = null;
      _loaded = true;
      syncBadge();
    }).catch(function () {
      _error = 'Could not load the queue.';
      _loaded = true;
    });
  }

  // ── the nav badge ─────────────────────────────────────────────────
  // Deliberately the count of things WAITING, not the unseen count the Crew
  // panel badges. An item you have looked at and not answered is still a
  // decision somebody is blocked on, and it should keep showing.
  function syncBadge() {
    var n = pendingCount();
    [document.getElementById('navQueueBadge'), document.getElementById('moreQueueBadge')].forEach(function (el) {
      if (!el) return;
      el.textContent = n > 9 ? '9+' : String(n);
      el.style.display = n ? '' : 'none';
    });
  }

  // ── render ────────────────────────────────────────────────────────
  function timeAgo(iso) {
    if (!iso) return '';
    var t = Date.parse(iso);
    if (!isFinite(t)) return '';
    var mins = Math.round((Date.now() - t) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    var hrs = Math.round(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    return Math.round(hrs / 24) + 'd ago';
  }

  function cardHTML(j) {
    var busy = !!_busy[j.id];
    return '' +
      '<article class="p86-q-card' + (j.id === _focusId ? ' is-focus' : '') + '" data-q-item="' + esc(j.id) + '">' +
        '<header class="p86-q-head">' +
          '<span class="p86-q-from">Background task</span>' +
          '<h3 class="p86-q-title">' + esc(j.title || 'Untitled task') + '</h3>' +
          '<span class="p86-q-when">' + esc(timeAgo(j.paused_at || j.created_at)) + '</span>' +
        '</header>' +
        '<p class="p86-q-ask">' + esc(j.pause_question) + '</p>' +
        '<div class="p86-q-act">' +
          '<input class="p86-q-answer" type="text" data-q-answer="' + esc(j.id) + '"' +
            ' placeholder="Your answer — it picks up where it left off"' +
            ' aria-label="Answer: ' + esc(j.pause_question) + '"' + (busy ? ' disabled' : '') + '>' +
          '<button type="button" class="ee-btn primary" data-q-send="' + esc(j.id) + '"' + (busy ? ' disabled' : '') + '>' +
            (busy ? 'Sending…' : 'Answer') + '</button>' +
        '</div>' +
        (j.prompt ? '<details class="p86-q-why"><summary>What it was asked to do</summary><p>' + esc(j.prompt) + '</p></details>' : '') +
      '</article>';
  }

  function historyHTML(j) {
    var tone = j.status === 'failed' ? 'bad' : j.status === 'done' ? 'ok' : 'mid';
    var word = j.status === 'done' ? 'Finished' : j.status === 'failed' ? 'Failed'
      : j.status === 'running' ? 'Working' : j.status === 'queued' ? 'Queued' : j.status;
    return '<li class="p86-q-past"><span class="p86-q-dot is-' + tone + '"></span>' +
      '<span class="p86-q-past-title">' + esc(j.title || 'Untitled task') + '</span>' +
      '<span class="p86-q-past-word">' + esc(word) + '</span>' +
      '<span class="p86-q-when">' + esc(timeAgo(j.completed_at || j.created_at)) + '</span></li>';
  }

  function paint() {
    if (!_host) return;
    if (!_loaded) {
      _host.innerHTML = '<div class="p86-q-empty">Loading…</div>';
      return;
    }
    if (_error) {
      _host.innerHTML = '<div class="p86-q-empty">' + esc(_error) + '</div>';
      return;
    }
    var w = waiting();
    var past = recent();
    var html = '<div class="p86-q-wrap">';
    html += '<div class="p86-q-top"><h2 class="p86-q-h">Queue</h2>' +
      '<span class="p86-q-sub">' + (w.length
        ? w.length + ' waiting on you'
        : 'Nothing waiting. Anything that needs a decision lands here.') + '</span></div>';
    if (w.length) {
      html += '<div class="p86-q-cards">' + w.map(cardHTML).join('') + '</div>';
    } else {
      html += '<div class="p86-q-empty p86-q-clear">All clear.</div>';
    }
    if (past.length) {
      html += '<section class="p86-q-recent"><h3 class="p86-q-recent-h">Recently</h3><ul class="p86-q-past-list">' +
        past.map(historyHTML).join('') + '</ul></section>';
    }
    html += '</div>';
    _host.innerHTML = html;
    if (_focusId) {
      var card = _host.querySelector('[data-q-item="' + _focusId.replace(/"/g, '') + '"]');
      if (card && card.scrollIntoView) card.scrollIntoView({ block: 'center' });
      var input = card ? card.querySelector('.p86-q-answer') : null;
      if (input) { try { input.focus(); } catch (e) { /* not focusable yet */ } }
      _focusId = null;
    }
    syncBadge();
  }

  // ── answering ─────────────────────────────────────────────────────
  function answer(id) {
    var input = _host && _host.querySelector('[data-q-answer="' + String(id).replace(/"/g, '') + '"]');
    var text = input ? String(input.value || '').trim() : '';
    if (!text) {
      if (input) input.focus();
      return;
    }
    _busy[id] = true;
    paint();
    api().post('/api/agent-jobs/' + encodeURIComponent(id) + '/answer', { answer: text })
      .then(function () {
        delete _busy[id];
        // The row stays needs_input until the worker claims it (up to ~10s),
        // so drop it from the list here rather than showing it as still
        // waiting on the next poll — the question has been answered.
        _jobs = _jobs.map(function (j) {
          return j.id === id ? Object.assign({}, j, { status: 'running', pause_question: null }) : j;
        });
        paint();
        if (typeof window.p86Toast === 'function') window.p86Toast('Answered — it is picking up where it left off.', 'success');
      })
      .catch(function () {
        // The old panel swallowed this silently, which looked exactly like
        // success. An answer that did not land has to say so.
        delete _busy[id];
        paint();
        if (typeof window.p86Toast === 'function') window.p86Toast('That answer did not send. Try again.', 'error');
      });
  }

  function onClick(e) {
    var send = e.target.closest && e.target.closest('[data-q-send]');
    if (send) { answer(send.getAttribute('data-q-send')); }
  }
  function onKey(e) {
    if (e.key !== 'Enter') return;
    var box = e.target.closest && e.target.closest('[data-q-answer]');
    if (box) { e.preventDefault(); answer(box.getAttribute('data-q-answer')); }
  }

  // ── lifecycle ─────────────────────────────────────────────────────
  function render(host) {
    _host = host || document.getElementById('queueHost');
    if (!_host) return;
    if (!_host.dataset.p86QWired) {
      _host.dataset.p86QWired = '1';
      _host.addEventListener('click', onClick);
      _host.addEventListener('keydown', onKey);
    }
    paint();
    load().then(paint);
    startPolling();
  }

  function startPolling() {
    if (_timer) return;
    _timer = setInterval(function () {
      // A hidden tab is not watching, and the worker tick is the real clock.
      if (document.hidden) return;
      var onPage = _host && _host.offsetParent !== null;
      load().then(function () { if (onPage) paint(); });
    }, POLL_MS);
  }

  function openItem(id) {
    _focusId = id || null;
    if (typeof window.switchTab === 'function') window.switchTab('queue');
    if (_loaded) paint();
  }

  // The badge is wanted even when the page has never been opened, so the
  // count is loaded once at boot and refreshed by the same poll.
  function boot() {
    if (!api()) return;
    load().then(syncBadge);
    startPolling();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(boot, 1200); });
  } else {
    setTimeout(boot, 1200);
  }

  window.p86Queue = {
    render: render,
    openItem: openItem,
    pendingCount: pendingCount,
    refresh: function () { return load().then(paint); },
    __test: { isWaiting: isWaiting, cardHTML: cardHTML, timeAgo: timeAgo }
  };
})();
