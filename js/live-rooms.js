// Live Rooms — phase 01 client. Presence, live cursors, and an honest host
// indicator. Nothing else: no Present popover, no hide-financials, no
// follow-me navigation, no whiteboard, no guest writes.
//
// THE RULE THIS FILE IS BUILT AROUND
// A surface must not claim more than it knows. A participant list is exactly
// the shape that gets this wrong: when the transport drops, the easy thing is
// to keep painting the last roster, and the faces stay on screen long after
// anyone can verify them. So the roster's honesty is a STATE MACHINE, it is
// pure, and it is exported for the test suite rather than reimplemented there —
// the tests exercise the code that actually ships.
//
// The client INFORMS; the server BOUNDS. Nothing here decides that a session is
// over. It asks.

(function () {
  'use strict';

  // ══ PURE CORE ══════════════════════════════════════════════════════════
  // No DOM, no network, no globals. Everything below this line is a function
  // of its arguments so it can be tested in Node.

  // How long a roster snapshot stays trustworthy. The server emits one every
  // 15s on a fixed cadence (not only on change), so 35s is two missed
  // snapshots — enough that a single dropped frame on cellular does not make
  // the UI flinch, short enough that a genuinely dead stream is caught fast.
  var ROSTER_FRESH_MS = 35000;
  var ROSTER_UNKNOWN_MS = 60000;
  var ATTEMPTS_BEFORE_UNKNOWN = 3;
  // How long a host's "the server confirmed this" lasts. Refreshed by any
  // successful beat (which returns a real status code) or roster snapshot.
  var CONFIRM_MS = 20000;

  // What the participant list shows, given the health of my own stream.
  //
  //   asserted  — show it. The server told me recently.
  //   caveated  — show it DIMMED and labelled. A caveat, not a claim.
  //   unknown   — EMPTY it. Not a stale roster with an apology attached: if I
  //               cannot verify who is watching, I must not draw their faces.
  //   ended     — no roster at all, and a reason.
  //
  // `s` = { terminal, terminalReason, attempts, msSinceSnapshot }
  function rosterState(s) {
    s = s || {};
    if (s.terminal) {
      return {
        kind: 'ended', showRoster: false, dim: false,
        message: endReasonText(s.terminalReason)
      };
    }
    var since = (s.msSinceSnapshot == null) ? Infinity : s.msSinceSnapshot;
    var attempts = s.attempts || 0;
    if (attempts >= ATTEMPTS_BEFORE_UNKNOWN || since >= ROSTER_UNKNOWN_MS) {
      return {
        kind: 'unknown', showRoster: false, dim: false,
        message: "Disconnected — we can't tell who's watching."
      };
    }
    if (since < ROSTER_FRESH_MS && attempts === 0) {
      return { kind: 'asserted', showRoster: true, dim: false, message: '' };
    }
    return {
      kind: 'caveated', showRoster: true, dim: true,
      message: 'Reconnecting — this list may be out of date.'
    };
  }

  // The roster actually painted. When the state says we do not know, this
  // returns nothing — the emptying is done HERE rather than left to each
  // caller to remember.
  function visibleParticipants(participants, state) {
    if (!state || !state.showRoster) return [];
    return (participants || []).filter(function (p) { return p && p.presence !== 'gone'; });
  }

  // Cursors get the SAME honesty rule as the roster, one layer down. A frozen
  // named cursor still painted beside a list that reads "we can't tell who's
  // watching" is the same defect, and it is the one that is easy to miss
  // because the roster gets all the attention. A cursor is drawn only while its
  // owner is verifiably live AND my own stream is asserting.
  function cursorVisible(participant, state) {
    if (!state || state.kind !== 'asserted') return false;
    if (!participant) return false;
    return participant.presence === 'live';
  }

  // The host's own indicator. Three states, and the middle one is the entire
  // reason to build this honestly — it is the state a pretty pill is tempted
  // to hide.
  function hostStripState(s) {
    s = s || {};
    if (!s.hosting) return { kind: 'idle', label: 'Go live', detail: '', watching: 0 };
    if (s.terminal) {
      return { kind: 'ended', label: 'Ended', detail: endReasonText(s.terminalReason), watching: 0 };
    }
    var since = (s.msSinceConfirm == null) ? Infinity : s.msSinceConfirm;
    if (since < CONFIRM_MS) {
      var n = s.watching || 0;
      return {
        kind: 'live', label: 'LIVE',
        detail: n === 1 ? '1 watching' : (n + ' watching'),
        watching: n
      };
    }
    return {
      kind: 'unconfirmed', label: 'LIVE?',
      detail: "can't confirm — you may still be broadcasting. Ending will take effect when the connection returns.",
      watching: s.watching || 0
    };
  }

  // Every way a session stops, named. A room that ends must SAY which of the
  // six paths it took; "Ended" alone leaves the host guessing whether they did
  // it or something else did.
  function endReasonText(reason) {
    switch (reason) {
      case 'host_ended':   return 'You ended this session.';
      case 'host_left':    return 'Session ended — the host closed it.';
      case 'host_timeout': return 'Session ended — the host stopped responding.';
      case 'expired':      return 'Session ended — it reached its time limit.';
      case 'link_revoked': return 'The link was revoked.';
      case 'superseded':   return 'You opened this session in another tab.';
      case 'kicked':       return 'You were removed from this session.';
      case 'not_found':    return 'This link is not valid.';
      case 'removed':      return 'You were removed from this session.';
      case 'server_restart': return 'Session ended — the server restarted.';
      default:             return 'This session has ended.';
    }
  }

  // ── Coordinates ─────────────────────────────────────────────────────────
  // ONE unit, stated once: x and y are BOTH integers 0..10000, normalised to
  // the document's content width and height. Not viewport pixels (screens
  // differ) and not a mix of normalised-x with pixel-y, which breaks silently
  // the first time a page is taller than ten thousand pixels.
  var COORD_MAX = 10000;
  function toDocCoords(pageX, pageY, docW, docH) {
    if (!docW || !docH) return null;
    var x = Math.round((pageX / docW) * COORD_MAX);
    var y = Math.round((pageY / docH) * COORD_MAX);
    if (!isFinite(x) || !isFinite(y)) return null;
    return [Math.max(0, Math.min(COORD_MAX, x)), Math.max(0, Math.min(COORD_MAX, y))];
  }
  function fromDocCoords(x, y, docW, docH) {
    return { left: (x / COORD_MAX) * docW, top: (y / COORD_MAX) * docH };
  }

  // Reconnect backoff. Capped, jittered — a room full of clients that all lost
  // the same proxy must not retry in lockstep.
  function backoffMs(attempt, rnd) {
    var r = (typeof rnd === 'number') ? rnd : Math.random();
    var base = Math.min(15000, 1000 * Math.pow(2, Math.max(0, attempt - 1)));
    return Math.round(base * (0.75 + r * 0.5));
  }

  var Core = {
    ROSTER_FRESH_MS: ROSTER_FRESH_MS,
    ROSTER_UNKNOWN_MS: ROSTER_UNKNOWN_MS,
    ATTEMPTS_BEFORE_UNKNOWN: ATTEMPTS_BEFORE_UNKNOWN,
    CONFIRM_MS: CONFIRM_MS,
    COORD_MAX: COORD_MAX,
    rosterState: rosterState,
    visibleParticipants: visibleParticipants,
    cursorVisible: cursorVisible,
    hostStripState: hostStripState,
    endReasonText: endReasonText,
    toDocCoords: toDocCoords,
    fromDocCoords: fromDocCoords,
    backoffMs: backoffMs
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Core;
  if (typeof window === 'undefined') return;   // Node: the pure core only.
  window.p86LiveCore = Core;

  // ══ CLIENT ENGINE ══════════════════════════════════════════════════════

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function docSize() {
    var d = document.documentElement, b = document.body;
    return {
      w: Math.max(d.scrollWidth, b ? b.scrollWidth : 0, d.clientWidth) || 1,
      h: Math.max(d.scrollHeight, b ? b.scrollHeight : 0, d.clientHeight) || 1
    };
  }

  // A live session, from this browser's point of view.
  //
  // RECONNECT IS OURS, NOT THE BROWSER'S. EventSource retries on its own, but
  // it surfaces no status code, no body and no headers when it fails — so a
  // client driven by its retry cannot tell "the room ended" from "my row aged
  // out while the tab slept" from "a limiter fired". It would tell a phone that
  // slept for an hour that the session ended, about a room still running.
  //
  // So onerror ALWAYS closes the stream, and recovery goes through the beat
  // endpoint, which answers with a real status code:
  //   200 -> my row and the room are both alive; reopen the stream
  //   404 -> my row is gone (timed out / kicked / superseded); ask status,
  //          then rejoin as a new participant if the room is still live
  //   410 -> the room is over, and the body says WHICH of the six ways
  //   429 -> back off. A limiter must never read as a terminated session.
  function LiveSession(opts) {
    this.token = opts.token;
    this.displayName = opts.displayName || null;
    this.onChange = opts.onChange || function () {};
    this.isHostSurface = !!opts.host;

    this.roomId = null;
    this.participantId = null;
    this.streamKey = null;
    this.role = null;
    this.room = null;
    this.beatMs = 5000;

    this.participants = [];
    this.cursors = {};          // participantId -> { target:[x,y], shown:[x,y], name }
    this.lastSnapshotAt = 0;
    this.lastConfirmAt = 0;
    this.lastSeq = 0;
    this.attempts = 0;
    this.terminal = false;
    this.terminalReason = null;
    this.multiInstance = false;

    this._es = null;
    this._beatTimer = null;
    this._retryTimer = null;
    this._samples = [];
    this._stopped = false;
  }

  LiveSession.prototype.state = function () {
    var now = Date.now();
    return rosterState({
      terminal: this.terminal,
      terminalReason: this.terminalReason,
      attempts: this.attempts,
      msSinceSnapshot: this.lastSnapshotAt ? (now - this.lastSnapshotAt) : null
    });
  };

  LiveSession.prototype._changed = function () {
    try { this.onChange(this); } catch (e) {}
  };

  LiveSession.prototype._terminate = function (reason) {
    this.terminal = true;
    this.terminalReason = reason || 'ended';
    this._teardownTransport();
    // The cursor layer goes with it. A frozen cursor outliving its session is
    // the roster defect one layer down.
    this.cursors = {};
    this.participants = [];
    this._changed();
  };

  LiveSession.prototype._teardownTransport = function () {
    if (this._es) { try { this._es.close(); } catch (e) {} this._es = null; }
    if (this._beatTimer) { clearInterval(this._beatTimer); this._beatTimer = null; }
    if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null; }
  };

  LiveSession.prototype.start = function () {
    var self = this;
    this._stopped = false;
    return this._join().then(function () { self._openStream(); self._startBeat(); })
      .catch(function (e) { self._scheduleRecover(); });
  };

  LiveSession.prototype._join = function () {
    var self = this;
    return fetch('/api/live/' + encodeURIComponent(this.token) + '/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      cache: 'no-store',
      body: JSON.stringify({ display_name: this.displayName })
    }).then(function (r) {
      if (r.status === 410) return r.json().then(function (j) { self._terminate(j && j.reason); throw new Error('ended'); });
      if (r.status === 403) return r.json().then(function (j) { self._terminate((j && j.code === 'REMOVED') ? 'removed' : 'ended'); throw new Error('removed'); });
      if (r.status === 404) { self._terminate('not_found'); throw new Error('not_found'); }
      if (!r.ok) throw new Error('join_failed_' + r.status);
      return r.json();
    }).then(function (j) {
      self.roomId = j.room_id;
      self.participantId = j.participant_id;
      self.streamKey = j.stream_key;
      self.role = j.role;
      self.displayName = j.display_name;
      self.beatMs = j.beat_ms || 5000;
      self.attempts = 0;
      self.lastSeq = 0;
      self.lastConfirmAt = Date.now();
      self._changed();
      return j;
    });
  };

  LiveSession.prototype._openStream = function () {
    var self = this;
    if (this._stopped || this.terminal || !this.roomId || !this.streamKey) return;
    if (this._es) { try { this._es.close(); } catch (e) {} }
    var url = '/api/live/' + encodeURIComponent(this.roomId) + '/stream/' +
      encodeURIComponent(this.streamKey) + '?after=' + (this.lastSeq || 0);
    var es;
    try { es = new EventSource(url, { withCredentials: true }); }
    catch (e) { this._scheduleRecover(); return; }
    this._es = es;
    es.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      self._handle(msg);
    };
    es.onerror = function () {
      // ALWAYS close. The browser's own retry is what we are replacing: it
      // would reconnect blind, with no way to learn why the stream died.
      try { es.close(); } catch (e) {}
      if (self._es === es) self._es = null;
      self._scheduleRecover();
    };
  };

  LiveSession.prototype._handle = function (msg) {
    if (!msg || !msg.type) return;
    if (typeof msg.seq === 'number' && msg.seq > this.lastSeq) this.lastSeq = msg.seq;
    var now = Date.now();
    switch (msg.type) {
      case 'hello':
        this.room = msg.room;
        this.participants = msg.participants || [];
        this.multiInstance = !!msg.multi_instance_suspected;
        if (msg.timings && msg.timings.beat_ms) this.beatMs = msg.timings.beat_ms;
        this.lastSnapshotAt = now; this.lastConfirmAt = now; this.attempts = 0;
        if (!msg.resumed) this.cursors = {};   // a reset is a reset
        this._changed();
        break;
      case 'presence':
        this.participants = msg.participants || [];
        this.lastSnapshotAt = now; this.lastConfirmAt = now; this.attempts = 0;
        this._pruneCursors();
        this._changed();
        break;
      case 'join':
      case 'leave':
        // Diffs move the surface between snapshots, but the SNAPSHOT is the
        // authority — the roster is never maintained by diffs alone.
        if (msg.type === 'leave') { delete this.cursors[msg.participant_id]; }
        this._changed();
        break;
      case 'cursor':
        this._ingestCursor(msg);
        break;
      case 'kicked':
        this._terminate('kicked');
        break;
      case 'superseded':
        this._terminate('superseded');
        break;
      case 'end':
        this._terminate(msg.reason);
        break;
    }
  };

  LiveSession.prototype._pruneCursors = function () {
    var byId = {};
    for (var i = 0; i < this.participants.length; i++) byId[this.participants[i].id] = this.participants[i];
    var st = this.state();
    for (var id in this.cursors) {
      if (!Object.prototype.hasOwnProperty.call(this.cursors, id)) continue;
      if (!cursorVisible(byId[id], st)) delete this.cursors[id];
    }
  };

  LiveSession.prototype._ingestCursor = function (msg) {
    var samples = msg.s || [];
    if (!samples.length) return;
    var last = samples[samples.length - 1];
    var name = 'Someone';
    for (var i = 0; i < this.participants.length; i++) {
      if (this.participants[i].id === msg.p) { name = this.participants[i].name; break; }
    }
    var c = this.cursors[msg.p] || { shown: [last[1], last[2]] };
    c.target = [last[1], last[2]];
    c.name = name;
    this.cursors[msg.p] = c;
  };

  // ── Recovery ────────────────────────────────────────────────────────────
  LiveSession.prototype._scheduleRecover = function () {
    var self = this;
    if (this._stopped || this.terminal) return;
    if (this._retryTimer) return;
    this.attempts += 1;
    this._changed();   // the roster starts caveating, then stops claiming
    var wait = backoffMs(this.attempts);
    this._retryTimer = setTimeout(function () {
      self._retryTimer = null;
      self._recover();
    }, wait);
  };

  LiveSession.prototype._recover = function () {
    var self = this;
    if (this._stopped || this.terminal) return;
    if (!this.roomId || !this.streamKey) { this._rejoinOrEnd(); return; }
    // The beat IS the probe: it is the one endpoint that answers with a real
    // status code about BOTH my participant row and the room.
    this._postBeat().then(function (verdict) {
      if (self._stopped || self.terminal) return;
      if (verdict === 'ok') { self._openStream(); self._startBeat(); return; }
      if (verdict === 'gone') { self._rejoinOrEnd(); return; }
      self._scheduleRecover();   // 429 / network / 5xx: back off, never die
    });
  };

  // My row is gone. That is NOT the same as the room being over — a slept tab
  // times out of a session that is still running, and telling that person
  // "this session ended" would be a false terminal. Ask, then rejoin.
  LiveSession.prototype._rejoinOrEnd = function () {
    var self = this;
    fetch('/api/live/' + encodeURIComponent(this.token) + '/status', { cache: 'no-store', credentials: 'same-origin' })
      .then(function (r) {
        if (r.status === 404) { self._terminate('not_found'); return null; }
        if (!r.ok) { self._scheduleRecover(); return null; }
        return r.json();
      })
      .then(function (j) {
        if (!j) return;
        if (!j.usable) { self._terminate(j.reason || j.state); return; }
        self.streamKey = null; self.participantId = null;
        self._join().then(function () { self._openStream(); self._startBeat(); })
          .catch(function () { self._scheduleRecover(); });
      })
      .catch(function () { self._scheduleRecover(); });
  };

  // ── The beacon ──────────────────────────────────────────────────────────
  LiveSession.prototype._startBeat = function () {
    var self = this;
    if (this._beatTimer) clearInterval(this._beatTimer);
    this._beatTimer = setInterval(function () { self._postBeat(); }, this.beatMs);
  };

  LiveSession.prototype._postBeat = function () {
    var self = this;
    if (this._stopped || this.terminal || !this.roomId || !this.streamKey) return Promise.resolve('gone');
    var batch = this._samples.splice(0, 12);
    return fetch('/api/live/' + encodeURIComponent(this.roomId) + '/beat/' + encodeURIComponent(this.streamKey), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      cache: 'no-store',
      body: JSON.stringify({ cursor: batch })
    }).then(function (r) {
      if (r.status === 200) {
        return r.json().then(function (j) {
          self.lastConfirmAt = Date.now();
          self.attempts = 0;
          if (typeof j.watching === 'number') self.watching = j.watching;
          self._changed();
          return 'ok';
        }, function () { self.lastConfirmAt = Date.now(); return 'ok'; });
      }
      if (r.status === 404) return 'gone';
      if (r.status === 410) {
        return r.json().then(function (j) { self._terminate(j && (j.reason || j.state)); return 'ended'; },
                             function () { self._terminate('ended'); return 'ended'; });
      }
      return 'retry';
    }).catch(function () { return 'retry'; });
  };

  // ── Leaving ─────────────────────────────────────────────────────────────
  // keepalive, and the local credentials are cleared BEFORE anything navigates.
  // The sub-portal logout trap is the precedent: a leave that races a
  // navigation leaves a credential behind, and a closed-and-reopened tab
  // silently resurrects a session someone thought was over.
  LiveSession.prototype.stop = function (why) {
    var roomId = this.roomId, key = this.streamKey;
    this._stopped = true;
    this.roomId = null; this.streamKey = null; this.participantId = null;
    this._teardownTransport();
    this.cursors = {}; this.participants = [];
    if (roomId && key) {
      try {
        fetch('/api/live/' + encodeURIComponent(roomId) + '/leave/' + encodeURIComponent(key), {
          method: 'POST', credentials: 'same-origin', keepalive: true,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ why: why || 'left' })
        }).catch(function () {});
      } catch (e) {}
    }
    this._changed();
  };

  // Sample my own pointer into the shared 0..10000 space.
  //
  // `w`/`h` name the surface the coordinates are relative to, and callers MUST
  // pass the surface they actually measured against — the app page passes its
  // document, the guest page passes its cursor stage. Defaulting both to the
  // document while a caller measures against something else is a silent
  // mis-normalisation that looks like a working cursor in the wrong place.
  //
  // Phase 01 is honest about what this does and does not buy: both ends speak
  // the same NORMALISED unit, so a cursor round-trips and tracks proportionally
  // on the receiver's surface. It does not yet mean both ends are looking at
  // the same document — that is phase 02's mirrored navigation, which is
  // exactly the thing that makes "look at this line right here" land on the
  // same line. The anchor field is reserved for it.
  LiveSession.prototype.sampleCursor = function (x, y, w, h) {
    if (w == null || h == null) { var d = docSize(); w = d.w; h = d.h; }
    var c = toDocCoords(x, y, w, h);
    if (!c) return;
    if (this._samples.length >= 12) this._samples.shift();
    this._samples.push([Date.now() % 100000, c[0], c[1]]);
  };

  // ══ CURSOR LAYER ═══════════════════════════════════════════════════════
  // Absolutely positioned over the document (not the viewport) so a cursor
  // stays on the thing it is pointing at while the page scrolls.
  function CursorLayer() {
    this.el = null;
    this.nodes = {};
    this._raf = null;
  }
  CursorLayer.prototype._ensure = function () {
    if (this.el && this.el.isConnected) return this.el;
    var el = document.createElement('div');
    el.className = 'p86-live-cursors';
    el.setAttribute('aria-hidden', 'true');
    document.body.appendChild(el);
    this.el = el;
    return el;
  };
  CursorLayer.prototype.clear = function () {
    if (this.el && this.el.parentNode) this.el.parentNode.removeChild(this.el);
    this.el = null; this.nodes = {};
  };
  CursorLayer.prototype.render = function (session) {
    var st = session.state();
    var byId = {};
    for (var i = 0; i < session.participants.length; i++) byId[session.participants[i].id] = session.participants[i];

    var any = false;
    for (var id in session.cursors) {
      if (Object.prototype.hasOwnProperty.call(session.cursors, id) &&
          id !== session.participantId && cursorVisible(byId[id], st)) { any = true; break; }
    }
    if (!any) { this.clear(); return; }

    var layer = this._ensure();
    var d = docSize();
    layer.style.height = d.h + 'px';
    var seen = {};
    for (var pid in session.cursors) {
      if (!Object.prototype.hasOwnProperty.call(session.cursors, pid)) continue;
      if (pid === session.participantId) continue;
      var p = byId[pid];
      if (!cursorVisible(p, st)) continue;
      seen[pid] = true;
      var c = session.cursors[pid];
      var node = this.nodes[pid];
      if (!node || !node.isConnected) {
        node = document.createElement('div');
        node.className = 'p86-live-cursor';
        node.innerHTML = '<svg viewBox="0 0 16 16" width="16" height="16"><path d="M2 1 L2 13 L5.5 9.8 L7.7 14.5 L9.8 13.5 L7.6 9 L12 9 Z"/></svg>' +
                         '<span class="p86-live-cursor-name"></span>';
        layer.appendChild(node);
        this.nodes[pid] = node;
      }
      node.querySelector('.p86-live-cursor-name').textContent = c.name || 'Someone';
      // Ease toward the target so a 1Hz wire cadence reads as motion.
      var shown = c.shown || c.target;
      shown = [shown[0] + (c.target[0] - shown[0]) * 0.35, shown[1] + (c.target[1] - shown[1]) * 0.35];
      c.shown = shown;
      var pos = fromDocCoords(shown[0], shown[1], d.w, d.h);
      node.style.transform = 'translate(' + Math.round(pos.left) + 'px,' + Math.round(pos.top) + 'px)';
    }
    for (var old in this.nodes) {
      if (!Object.prototype.hasOwnProperty.call(this.nodes, old)) continue;
      if (!seen[old]) {
        if (this.nodes[old].parentNode) this.nodes[old].parentNode.removeChild(this.nodes[old]);
        delete this.nodes[old];
      }
    }
  };

  // ══ HOST STRIP ═════════════════════════════════════════════════════════
  // Appended to document.body as a fixed element, DELIBERATELY not into
  // .job-detail-header: workspace-layout.js:382 sets that container to
  // display:none unconditionally — no flag, no breakpoint — so anything placed
  // there is invisible to everyone. Body-fixed also means no layout container
  // can hide the one surface whose whole job is to tell you that you are
  // broadcasting.
  var host = {
    session: null,
    layer: new CursorLayer(),
    el: null,
    endedUntil: 0,
    lastEndReason: null,
    jobId: null,
    _tick: null
  };

  function currentJobId() {
    try {
      var detail = document.getElementById('jobs-job-detail-view');
      if (!detail || detail.style.display === 'none') return null;
      return (typeof appState !== 'undefined' && appState && appState.currentJobId) ? appState.currentJobId : null;
    } catch (e) { return null; }
  }

  function stripEl() {
    if (host.el && host.el.isConnected) return host.el;
    var el = document.createElement('div');
    el.className = 'p86-live-strip';
    el.style.display = 'none';
    document.body.appendChild(el);
    el.addEventListener('click', function (ev) {
      var act = ev.target && ev.target.closest ? ev.target.closest('[data-live-act]') : null;
      if (!act) return;
      ev.preventDefault();
      var a = act.getAttribute('data-live-act');
      if (a === 'start') startHosting();
      else if (a === 'end') endHosting();
      else if (a === 'kick') kickParticipant(act.getAttribute('data-pid'), act.getAttribute('data-revoke') === '1');
      else if (a === 'copy') copyLink();
      else if (a === 'roster') { el.classList.toggle('is-open'); paintStrip(); }
    });
    host.el = el;
    return el;
  }

  function paintStrip() {
    var el = stripEl();
    var jobId = currentJobId();
    var s = host.session;
    var now = Date.now();

    var view = hostStripState({
      hosting: !!(s && !s.terminal),
      terminal: !!(s && s.terminal),
      terminalReason: s ? s.terminalReason : null,
      watching: s ? Math.max(0, (s.participants || []).filter(function (p) { return p.role !== 'host'; }).length) : 0,
      msSinceConfirm: s ? (now - s.lastConfirmAt) : null
    });

    // Sticky "Ended" so an expiry or a restart is SEEN rather than silently
    // absorbed — the host must be able to tell that it stopped, and why.
    if (s && s.terminal && !host.endedUntil) { host.endedUntil = now + 10000; host.lastEndReason = s.terminalReason; }
    if (!s && host.endedUntil && now < host.endedUntil) {
      view = { kind: 'ended', label: 'Ended', detail: endReasonText(host.lastEndReason), watching: 0 };
    } else if (!s && host.endedUntil && now >= host.endedUntil) {
      host.endedUntil = 0; host.lastEndReason = null;
    }

    if (view.kind === 'idle' && !jobId) { el.style.display = 'none'; return; }
    el.style.display = '';
    el.setAttribute('data-state', view.kind);

    var html = '';
    if (view.kind === 'idle') {
      html = '<button type="button" class="p86-live-btn" data-live-act="start">' +
             '<span class="p86-live-dot"></span>Go live</button>';
    } else if (view.kind === 'ended') {
      html = '<span class="p86-live-label">Ended</span>' +
             '<span class="p86-live-detail">' + esc(view.detail) + '</span>';
    } else {
      html = '<button type="button" class="p86-live-pill" data-live-act="roster">' +
             '<span class="p86-live-dot"></span>' +
             '<span class="p86-live-label">' + esc(view.label) + '</span>' +
             '<span class="p86-live-detail">' + esc(view.kind === 'live' ? view.detail : "can't confirm") + '</span>' +
             '</button>' +
             '<button type="button" class="p86-live-btn is-ghost" data-live-act="copy">Copy link</button>' +
             '<button type="button" class="p86-live-btn is-end" data-live-act="end">End</button>';
      if (view.kind === 'unconfirmed') {
        html += '<div class="p86-live-warn">' + esc(view.detail) + '</div>';
      }
      if (s && s.multiInstance) {
        html += '<div class="p86-live-warn">This session keeps moving between servers — some viewers may be seeing a different room.</div>';
      }
      if (el.classList.contains('is-open')) html += rosterHtml(s);
    }
    el.innerHTML = html;
  }

  function rosterHtml(s) {
    if (!s) return '';
    var st = s.state();
    var list = visibleParticipants(s.participants, st);
    var out = '<div class="p86-live-roster' + (st.dim ? ' is-dim' : '') + '">';
    if (st.message) out += '<div class="p86-live-roster-note">' + esc(st.message) + '</div>';
    if (!st.showRoster) { return out + '</div>'; }
    if (!list.length) { return out + '<div class="p86-live-roster-note">Nobody is watching yet.</div></div>'; }
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      out += '<div class="p86-live-row' + (p.presence === 'stale' ? ' is-stale' : '') + '">' +
             '<span class="p86-live-who">' + esc(p.name) + (p.guest ? ' <em>guest</em>' : '') + '</span>' +
             (p.presence === 'stale' ? '<span class="p86-live-flag">not responding</span>' : '') +
             (p.role === 'host' ? '<span class="p86-live-flag">host</span>' :
               '<span class="p86-live-acts">' +
               '<button type="button" data-live-act="kick" data-pid="' + esc(p.id) + '">Remove</button>' +
               '<button type="button" data-live-act="kick" data-pid="' + esc(p.id) + '" data-revoke="1">Remove &amp; revoke link</button>' +
               '</span>') +
             '</div>';
    }
    return out + '</div>';
  }

  function toast(msg) {
    try { if (window.showToast) return window.showToast(msg); } catch (e) {}
    try { console.log('[live]', msg); } catch (e) {}
  }

  function startHosting() {
    var jobId = currentJobId();
    if (!jobId) return;
    fetch('/api/live/rooms', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin', cache: 'no-store',
      body: JSON.stringify({ entity_type: 'job', entity_id: jobId })
    }).then(function (r) {
      return r.json().then(function (j) { return { ok: r.ok, body: j }; });
    }).then(function (res) {
      if (!res.ok) { toast(res.body && res.body.error ? res.body.error : 'Could not start the live session.'); return; }
      host.endedUntil = 0;
      attachSession(res.body.token, true);
      copyLink();
    }).catch(function () { toast('Could not start the live session.'); });
  }

  function attachSession(token, isHostSurface) {
    if (host.session) host.session.stop('restart');
    host.token = token;
    var s = new LiveSession({
      token: token, host: isHostSurface,
      onChange: function () { paintStrip(); host.layer.render(s); }
    });
    host.session = s;
    s.start();
    paintStrip();
  }

  function endHosting() {
    var s = host.session;
    if (!s || !s.roomId) return;
    var roomId = s.roomId;
    // Deliberately does NOT claim success here. The button is the fast path;
    // the strip keeps saying "you may still be broadcasting" until the server's
    // own `end` event or a status probe confirms it. A toast computed before
    // the request resolves is the exact defect this project has been removing.
    fetch('/api/live/rooms/' + encodeURIComponent(roomId) + '/end', {
      method: 'POST', credentials: 'same-origin', keepalive: true
    }).then(function (r) {
      if (!r.ok) toast('Could not end the session yet — it will end on its own shortly.');
    }).catch(function () {
      toast("Couldn't reach the server. The session ends on its own within two minutes.");
    });
  }

  function kickParticipant(pid, revoke) {
    var s = host.session;
    if (!s || !s.roomId || !pid) return;
    if (!revoke && !window.confirm('Remove this person from the session?\n\nThey still hold the link and can rejoin. Use "Remove & revoke link" to stop that.')) return;
    if (revoke && !window.confirm('Revoke the link?\n\nThis ends the session for everyone and the link stops working.')) return;
    fetch('/api/live/rooms/' + encodeURIComponent(s.roomId) + '/kick', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ participant_id: pid, revoke: !!revoke })
    }).then(function (r) { return r.json(); })
      .then(function (j) { if (j && j.note) toast(j.note); })
      .catch(function () { toast('Could not remove that participant.'); });
  }

  function copyLink() {
    if (!host.token) return;
    var url = location.origin + '/live/' + host.token;
    try {
      navigator.clipboard.writeText(url).then(function () { toast('Viewer link copied.'); },
                                              function () { window.prompt('Viewer link', url); });
    } catch (e) { window.prompt('Viewer link', url); }
  }

  // On boot, ask the SERVER what I am hosting. Without this, a host who
  // pressed F5 is broadcasting with no indicator at all until the 120s
  // backstop fires — the exact defect the strip exists to prevent, reached by
  // an ordinary reload. localStorage would be the wrong answer here: this repo
  // has already been bitten by a cache resurrecting state the server had
  // dropped.
  function adoptExistingRooms() {
    fetch('/api/live/mine', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j || !j.rooms || !j.rooms.length) return;
        if (host.session && !host.session.terminal) return;
        attachSession(j.rooms[0].token, true);
      }).catch(function () {});
  }

  function wireCursorSampling() {
    var last = 0;
    document.addEventListener('pointermove', function (ev) {
      var s = host.session;
      if (!s || s.terminal || !s.roomId) return;
      var now = Date.now();
      if (now - last < 100) return;   // 10 Hz sampling, shipped at 1 Hz
      last = now;
      s.sampleCursor(ev.pageX, ev.pageY);
    }, { passive: true });
  }

  function boot() {
    stripEl();
    wireCursorSampling();
    adoptExistingRooms();
    // Repaint on a timer as well as on events: "can't confirm" is a state
    // reached by the ABSENCE of news, so nothing will fire an event to
    // announce it.
    host._tick = setInterval(function () {
      try { paintStrip(); if (host.session) host.layer.render(host.session); } catch (e) {}
    }, 1000);
    // Closing the tab stops the broadcast on the fast path. The 120s host
    // beacon backstop covers the case where this never lands.
    window.addEventListener('pagehide', function () {
      if (host.session && host.session.roomId) host.session.stop('pagehide');
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  window.p86Live = {
    core: Core,
    Session: LiveSession,
    CursorLayer: CursorLayer,
    startForJob: startHosting,
    end: endHosting,
    current: function () { return host.session; }
  };
})();
