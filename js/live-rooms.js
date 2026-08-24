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
      // A guest page was handed the HOST role. It refuses rather than steering
      // the room from a read-only shell, and says so instead of looking broken.
      case 'role_refused': return 'This page opened as the presenter by mistake and stopped. Reload to watch.';
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

  // What a `hello` actually means for state we are already holding.
  //
  // lastSeq only ever RISES (a frame with a lower seq is ignored) and is reset
  // in exactly one place, _join(). A reconnect that does not re-join therefore
  // carries its old lastSeq into a hub that may have restarted at zero — which
  // is the normal deploy path, not an edge case. The server now refuses to
  // claim a resume it cannot prove, but the client must not depend on the
  // server's answer alone: a hello whose seq is BELOW our lastSeq is proof on
  // its own that this is a different hub, whatever the resumed flag says.
  //
  // 'reset' means: drop what we are holding and take what arrives. That is the
  // honest answer — showing a cursor trail from a hub that no longer exists is
  // the stale-state failure this whole feature is supposed to refuse.
  function resumeVerdict(helloSeq, lastSeq, resumed) {
    if (typeof helloSeq === 'number' && helloSeq < (lastSeq || 0)) return 'reset';
    return resumed ? 'resumed' : 'reset';
  }

  // ── Which room this tab may adopt ───────────────────────────────────────
  // A reload has to restore the indicator, but adopting the WRONG room is the
  // defect that produced "he is on a different record". GET /api/live/mine
  // returns EVERY live room this user hosts — one per ENTITY, each usable for
  // hours — and taking rooms[0] blindly attaches this tab, AS HOST, to a room
  // whose record is not the one on screen. The one-host-row rule then supersedes
  // whichever tab was really presenting, and every beat from the adopting tab
  // reports a foreign record, so hostViewEvent refuses the mirror and every
  // guest is told "not shared" and can never load a first document.
  //
  // So adoption is now a MATCH, not a pick. A live room for some other record
  // is still counted, because a host who is broadcasting must be told he is
  // broadcasting — but it is reported as `elsewhere`, which the strip STATES
  // and never joins.
  function adoptionVerdict(rooms, route) {
    var list = Array.isArray(rooms) ? rooms : [];
    var et = (route && route.entity_type) ? String(route.entity_type) : null;
    var eid = (route && route.entity_id != null && route.entity_id !== '') ? String(route.entity_id) : null;
    var adopt = null, elsewhere = 0;
    for (var i = 0; i < list.length; i++) {
      var r = list[i] || {};
      var same = !!(et && eid && String(r.entity_type) === et && String(r.entity_id) === eid);
      if (same && !adopt) adopt = r;
      else elsewhere += 1;
    }
    return { adopt: adopt, elsewhere: elsewhere };
  }

  // ── What the viewers can actually see, said to the HOST ─────────────────
  // The server already tells the host this and the host already receives it:
  // his own `view` frame comes back on his own stream carrying the verdict the
  // guests were given. Phase 02 stored it in hostView and read it NOWHERE, so
  // the one state that matters most — MY VIEWERS ARE LOOKING AT NOTHING — was
  // spelled out on every guest's bar and invisible to the presenter. That is
  // the roster's honesty rule pointed the other way, and it is the reason this
  // defect was reported by the room rather than by the app.
  //
  // It NAMES the verdict rather than softening it. And it is a REPORT, never a
  // command: the host's own echo must not move the host. Applying it would
  // replace the presenter's document with the guest projection, which is the
  // one thing this feature must never do to the presenter's own app.
  function mirrorNotice(hostView, watching) {
    var v = hostView || {};
    if (v.surface) return '';
    var n = watching || 0;
    var who = n === 1 ? 'Your viewer' : (n > 1 ? ('Your ' + n + ' viewers') : 'Viewers');
    switch (v.reason) {
      case 'off_room':
        return who + " can't see this — you're on a different record than the one you're presenting.";
      case 'not_shared':
        return who + " can't see this screen — it isn't one of the shared screens.";
      case 'away':
        return who + " can't see anything — you've left the job you're presenting.";
      default:
        // No verdict yet. Saying nothing is correct; a warning before the first
        // beat would be the surface claiming more than it knows.
        return '';
    }
  }

  // ── What one viewer is reading, from the host's side ────────────────────
  // "not loaded yet" was printed for EVERY viewer with no observed surface,
  // which collapses three different situations into one sentence that blames
  // the viewer. Worst of them: when the host's own screen is not being mirrored
  // there is nothing to load, so a perfectly healthy guest reads as a broken
  // one and the host goes looking for the fault at the wrong end.
  var VIEWER_LOAD_GRACE_MS = 20000;
  function viewerWhere(participant, hostSurface, label, now) {
    var p = participant || {};
    if (p.surface) {
      var where = label || p.surface;
      return p.following ? where : ('broke off — ' + where);
    }
    if (!hostSurface) return 'nothing to show — your screen is not being shared';
    var t = Date.parse(p.joined_at);
    if (isFinite(t) && (now || Date.now()) - t > VIEWER_LOAD_GRACE_MS) {
      return "hasn't loaded — they may not be getting through";
    }
    return 'loading…';
  }

  // ── The Ended notice ────────────────────────────────────────────────────
  // How long it stays up before the strip returns to idle. It is a NOTICE, not
  // a state: the terminated session is RELEASED when it expires.
  var ENDED_STICKY_MS = 10000;

  // Pure, because both halves of this were unreachable in the version that
  // shipped and neither could be caught by a test that could not run them:
  // hostStripState was handed `hosting: !!(s && !s.terminal)`, so its own
  // `terminal` branch was dead; and the sticky branch was gated on the session
  // being ABSENT while the session object is only ever assigned, never nulled.
  // Between them, every way a session dies — supersede, expiry, revoke, server
  // restart — flipped the strip silently back to a "Present" button while the
  // host went on talking to a room that had stopped listening.
  //
  // `release` is the half that also re-arms it: without nulling the terminated
  // session, `endedUntil` stays set forever and the NEXT end shows nothing.
  function endedNoticeVerdict(s) {
    s = s || {};
    var now = s.now || 0;
    var until = s.endedUntil || 0;
    if (s.terminal && !until) return { show: true, until: now + ENDED_STICKY_MS, release: false };
    if (until && now < until) return { show: true, until: until, release: false };
    if (until) return { show: false, until: 0, release: !!s.terminal };
    return { show: false, until: 0, release: false };
  }

  var Core = {
    resumeVerdict: resumeVerdict,
    adoptionVerdict: adoptionVerdict,
    endedNoticeVerdict: endedNoticeVerdict,
    ENDED_STICKY_MS: ENDED_STICKY_MS,
    mirrorNotice: mirrorNotice,
    viewerWhere: viewerWhere,
    VIEWER_LOAD_GRACE_MS: VIEWER_LOAD_GRACE_MS,
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
    // A join may always ask for LESS. The guest page asks for `viewer`
    // explicitly, because the host role is decided from the COOKIE and the
    // cookie rides every same-origin request — including the one live.html
    // makes. Without this, the host opening the link he just copied joined his
    // own room AS HOST from the guest tab, tripped the one-host-row supersede
    // rule, and terminated the tab he was actually presenting from. 2dd1239
    // closed the boot() half of that; this closes the join.
    this.asViewer = !!opts.asViewer;

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

    // ── Phase 02 ──────────────────────────────────────────────────────────
    // Where the HOST is, as the server reports it: a surface and a reason,
    // never a record. `hostView.surface === null` with a reason is the honest
    // "he is somewhere this room does not share" state, and the guest bar says
    // which of the three it is rather than freezing on a stale screen.
    this.hostView = { surface: null, reason: null };
    // What this recipient may be shown, said by the server on `hello` rather
    // than assumed by the client. A client-side guess here is how a bar ends up
    // claiming numbers are hidden while they sit in the response.
    this.policy = { money: false };
    this.surfaces = [];
    // ── Phase 03 ──────────────────────────────────────────────────────────
    // WHICH ARRANGEMENT this is, said by the server on `hello` and on every
    // `mode` event, never inferred from what happens to arrive. A viewer who
    // believes they are seeing a filtered view while receiving a raw one is the
    // bad outcome of this whole feature, and the inverse is only marginally
    // better, so the mode is stated on both bars from this one field.
    this.mode = 'projected';
    // Which surfaces this room can mirror at all. The rest still serve their
    // structured document, so a screen the mirror refuses degrades to phase
    // 02's projection rather than to a pause.
    this.mirrorSurfaces = [];
    // The mirror POINTER — never the frame. The frame is pulled.
    this.mirror = { snapSeq: 0, surface: null, at: null, reason: null, w: 0, h: 0 };
    // Ops are handed straight through rather than buffered on the session: a
    // delta is only meaningful against the base the applier is holding, and a
    // session that queued them would be holding a second, divergent idea of the
    // document.
    this.onMirror = opts.onMirror || null;
    // Freshness of the MIRROR specifically. Any frame — including the SSE
    // keepalive's sibling events — refreshes it; "we can't tell what he is
    // looking at" is a state reached by the ABSENCE of news.
    this.lastFrameAt = 0;
    // The host's own outgoing route. Deduped here so an unchanged route costs
    // zero bytes and burns no seq. `_routeKey` stays null until the host
    // surface has actually reported once, so a fresh session does not announce
    // "away" before anybody has looked at anything.
    this._route = null;
    this._routeKey = null;
    this._routeFlush = null;

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
      // `as` is DOWNGRADE-ONLY on the server, so it can be believed without
      // authorizing anything: a request asking for less is always safe to grant.
      body: JSON.stringify({ display_name: this.displayName, as: this.asViewer ? 'viewer' : undefined })
    }).then(function (r) {
      if (r.status === 410) return r.json().then(function (j) { self._terminate(j && j.reason); throw new Error('ended'); });
      if (r.status === 403) return r.json().then(function (j) { self._terminate((j && j.code === 'REMOVED') ? 'removed' : 'ended'); throw new Error('removed'); });
      if (r.status === 404) { self._terminate('not_found'); throw new Error('not_found'); }
      if (!r.ok) throw new Error('join_failed_' + r.status);
      return r.json();
    }).then(function (j) {
      // Verified on the way back, not merely requested. A page that asked to be
      // a viewer and was handed `host` would be steering the room from a
      // read-only shell — and every symptom of that is silent. Refusing is
      // loud, which is the trade this feature keeps making.
      if (self.asViewer && j && j.role === 'host') {
        self._terminate('role_refused');
        throw new Error('role_refused');
      }
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
    this.lastFrameAt = now;
    switch (msg.type) {
      case 'hello':
        this.room = msg.room;
        this.participants = msg.participants || [];
        this.multiInstance = !!msg.multi_instance_suspected;
        if (msg.policy) this.policy = { money: !!msg.policy.money };
        if (msg.view) this.hostView = { surface: msg.view.surface || null, reason: msg.view.reason || null };
        if (Array.isArray(msg.surfaces)) this.surfaces = msg.surfaces;
        if (Array.isArray(msg.mirror_surfaces)) this.mirrorSurfaces = msg.mirror_surfaces;
        this.mode = (msg.room && msg.room.mode === 'mirror') ? 'mirror' : 'projected';
        // The current mirror pointer, for the same reason `view` is here:
        // without it a mid-session joiner stares at nothing until the host's
        // next wholesale repaint, which on the WIP pane can be minutes.
        if (msg.mirror && msg.mirror.snapSeq) {
          this.mirror = {
            snapSeq: msg.mirror.snapSeq, surface: msg.mirror.surface || null,
            at: msg.mirror.at || null, reason: null, w: 0, h: 0
          };
          if (this.onMirror) { try { this.onMirror('snap', this.mirror); } catch (e) {} }
        }
        if (msg.timings && msg.timings.beat_ms) this.beatMs = msg.timings.beat_ms;
        this.lastSnapshotAt = now; this.lastConfirmAt = now; this.attempts = 0;
        // A reset is a reset — including the case the resumed flag cannot see,
        // where this hello comes from a hub that restarted below our position.
        if (resumeVerdict(msg.seq, this.lastSeq, msg.resumed) === 'reset') {
          this.cursors = {};
          this.lastSeq = (typeof msg.seq === 'number') ? msg.seq : 0;
        }
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
      case 'view':
        // A route, not a screen. The surface is the whole payload; there is
        // deliberately no record id to act on.
        this.hostView = { surface: msg.surface || null, reason: msg.reason || null };
        this._changed();
        break;
      case 'policy':
        // The arrangement changed. The listener DISCARDS its document and
        // refetches — it never patches. Flipping off must not become a
        // client-side unhide of data the client already lacks; flipping on must
        // not leave a document with live numbers sitting in memory.
        this.policy = { money: !msg.hide_financials };
        this._changed();
        break;
      case 'mode':
        // Same discipline as `policy`: the listener DISCARDS and rebuilds. A
        // mirrored frame surviving a switch to the structured view is the same
        // class of defect as a revoked link leaving the WIP table on screen.
        this.mode = (msg.mode === 'mirror') ? 'mirror' : 'projected';
        this.mirror = { snapSeq: 0, surface: null, at: null, reason: null, w: 0, h: 0 };
        if (this.onMirror) { try { this.onMirror('mode', { mode: this.mode }); } catch (e) {} }
        this._changed();
        break;
      case 'mirror-snap':
        // A POINTER, ~60 bytes. The frame is pulled over an ordinary GET, which
        // compresses (the SSE stream sets no-transform and cannot) and which
        // each guest fetches at its own pace instead of one slow phone stalling
        // a synchronous fan-out to twenty-five of them.
        this.mirror = {
          snapSeq: msg.snapSeq || 0, surface: msg.surface || null, at: msg.at || null,
          reason: null, w: msg.w || 0, h: msg.h || 0
        };
        if (this.onMirror) { try { this.onMirror('snap', this.mirror); } catch (e) {} }
        this._changed();
        break;
      case 'mirror-op':
        // Handed straight through, WITH the snapSeq it was cut against. An
        // applier holding a different base drops the batch and pulls: a patch
        // applied to the wrong document is worse than a missing patch, because
        // it looks like data.
        if (this.onMirror) { try { this.onMirror('ops', msg); } catch (e) {} }
        break;
      case 'mirror-off':
        // The host moved somewhere the mirror does not follow. The guest is
        // TOLD, and the last frame keeps its capture time — a stale screen is
        // never presented as current.
        this.mirror = { snapSeq: 0, surface: null, at: this.mirror ? this.mirror.at : null, reason: msg.reason || 'away', w: 0, h: 0 };
        if (this.onMirror) { try { this.onMirror('off', this.mirror); } catch (e) {} }
        this._changed();
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

  // ── The host's route, out ───────────────────────────────────────────────
  // EDGE-TRIGGERED, not sampled, and it rides the beat that already exists:
  // zero new bytes on the wire, zero new connections, zero new endpoints.
  //
  // But the beat interval is 5s and the study says "within a beat", so a route
  // change FLUSHES a beat immediately instead of waiting for the next tick.
  // Debounced, because nav functions call each other in quick succession
  // (switchTab -> activateTab -> ...) and only the final state matters.
  //
  // The route is sent as claimed; the SERVER decides whether it is inside the
  // room. That is the only correct split: a client that filtered its own route
  // would be the authorization.
  LiveSession.prototype.setRoute = function (route) {
    if (this.role !== 'host') return;
    var key = route ? (String(route.entity_type) + '|' + String(route.entity_id) + '|' + String(route.surface)) : 'null';
    if (key === this._routeKey) return;
    this._routeKey = key;
    this._route = route || null;
    var self = this;
    if (this._routeFlush) return;
    this._routeFlush = setTimeout(function () {
      self._routeFlush = null;
      self._postBeat();
    }, 120);
  };

  LiveSession.prototype._postBeat = function () {
    var self = this;
    if (this._stopped || this.terminal || !this.roomId || !this.streamKey) return Promise.resolve('gone');
    var batch = this._samples.splice(0, 12);
    var body = { cursor: batch };
    // Only a host sends a route at all. The server drops one from a viewer
    // anyway — authorize at execution, not at proposal — but there is no
    // reason to send bytes that exist only to be refused.
    if (this.role === 'host' && this._routeKey != null) body.view = this._route;
    return fetch('/api/live/' + encodeURIComponent(this.roomId) + '/beat/' + encodeURIComponent(this.streamKey), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      cache: 'no-store',
      body: JSON.stringify(body)
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
    // Rooms this user is hosting for OTHER records, from /api/live/mine. Named
    // by the strip, never joined by it.
    elsewhere: 0,
    // The unadopted answer from /api/live/mine, retried against the route on
    // the 1Hz tick: at DOMContentLoaded the job detail has not rendered yet, so
    // a single match attempt at boot would miss the reload case this whole
    // mechanism exists for.
    mine: null,
    mineUntil: 0,
    // Default ON. The link is a bearer credential this feature explicitly
    // designs for being pasted into a group chat, and the safe default for a
    // forwardable credential is the narrow one. The server's column carries the
    // same default, so this is a mirror of the row and never the authority.
    hideFinancials: true,
    // Phase 03. Default 'projected', mirroring the column's own default, for
    // the same reason hideFinancials defaults on: the link is a bearer
    // credential this feature designs for being pasted into a group chat, and
    // the safe default for a forwardable credential is the narrow one. This is
    // a mirror of the row and never the authority.
    mode: 'projected',
    _tick: null
  };

  // ── The host's route, read from the DOM ────────────────────────────────
  // The same signals js/router.js captureRouteFromDOM reads, deliberately NOT
  // by calling into it: that module is the URL's business and it is being
  // edited by other work. Precedence follows the current nav model — the Site
  // Map overlay, then the right-tab strip's data-panel, then the legacy
  // sub-tab button — and NOT js/app.js captureNavState, which is the older twin
  // with no job-sub at all.
  //
  // The surface is reported AS FOUND. This function does not filter it against
  // the shared set, because the server decides what is shared: a client that
  // filtered its own route would be the authorization.
  function captureHostRoute() {
    try {
      var topBtn = document.querySelector('.tab-btn.active');
      var top = topBtn ? topBtn.getAttribute('data-tab') : null;
      var jobId = currentJobId();
      if (top !== 'jobs' || !jobId) return { entity_type: null, entity_id: null, surface: null };
      var surface = null;
      var ng = document.getElementById('nodeGraphTab');
      if (ng && ng.classList.contains('active')) {
        surface = 'job-site-map';
      } else {
        var rTab = document.querySelector('.ws-right-tab.active');
        surface = rTab ? rTab.getAttribute('data-panel') : null;
        if (!surface) {
          var subBtn = document.querySelector('.sub-tab-btn-job.active');
          surface = subBtn ? subBtn.getAttribute('data-subtab') : null;
        }
      }
      return { entity_type: 'job', entity_id: jobId, surface: surface };
    } catch (e) {
      return { entity_type: null, entity_id: null, surface: null };
    }
  }

  function pushRoute() {
    var s = host.session;
    if (!s || s.terminal) return;
    try { s.setRoute(captureHostRoute()); } catch (e) {}
  }

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
      else if (a === 'policy') setHideFinancials(act.getAttribute('data-hide') === '1');
      else if (a === 'mode') setMode(act.getAttribute('data-mode'));
      else if (a === 'roster') { el.classList.toggle('is-open'); paintStrip(); }
    });
    host.el = el;
    return el;
  }

  // ── Account-menu "Present this job" entry ───────────────────────────────
  // The idle start action lives in #user-avatar-menu (the name-badge popover)
  // instead of a floating header button. The LIVE / ENDED strip stays on the
  // body, unchanged — its roster / End / status must never hide behind a click.
  // wireMenuBtn() binds the click once; syncMenuBtn() shows/hides the item on
  // every paintStrip() (1Hz tick + events) so it tracks job + hosting state.
  function wireMenuBtn() {
    var btn = document.getElementById('present-menu-btn');
    if (!btn || btn._p86wired) return;
    btn._p86wired = true;
    btn.addEventListener('click', function (ev) {
      ev.preventDefault();
      // Close the popover so the live strip is unobstructed the moment we go up.
      var menu = document.getElementById('user-avatar-menu');
      if (menu) menu.setAttribute('hidden', '');
      startHosting();
    });
  }
  function syncMenuBtn(view, jobId) {
    var btn = document.getElementById('present-menu-btn');
    if (!btn) return;
    // Offer the start action only when nothing is live on this tab (idle) and
    // we're on a job to present. While a session is live or showing its ended
    // notice, the floating strip owns the controls and this steps aside.
    btn.hidden = !(view && view.kind === 'idle' && !!jobId);
  }

  function paintStrip() {
    var el = stripEl();
    var jobId = currentJobId();
    var s = host.session;
    var now = Date.now();

    // Sticky "Ended" so an expiry, a supersede or a restart is SEEN rather than
    // silently absorbed — the host must be able to tell that it stopped, and
    // why. BOTH halves of this were unreachable: hostStripState was handed
    // `hosting: !!(s && !s.terminal)`, which is false the moment a session goes
    // terminal, so its own `terminal` branch could never run; and the sticky
    // branch below was gated on `!s` while host.session is only ever assigned,
    // never nulled. Between them, every way a session dies flipped the strip
    // straight back to a "Present" button and the host went on talking to a
    // room that had stopped listening. The session is released HERE, when the
    // notice has been shown, which is also what re-arms it for the next end.
    if (s && s.terminal && !host.endedUntil) host.lastEndReason = s.terminalReason;
    var ended = endedNoticeVerdict({ terminal: !!(s && s.terminal), endedUntil: host.endedUntil, now: now });
    host.endedUntil = ended.until;
    if (ended.release) { host.session = null; host.token = null; s = null; host.lastEndReason = null; }

    var view = hostStripState({
      hosting: !!(s && !s.terminal),
      terminal: !!(s && s.terminal),
      terminalReason: s ? s.terminalReason : null,
      watching: s ? Math.max(0, (s.participants || []).filter(function (p) { return p.role !== 'host'; }).length) : 0,
      msSinceConfirm: s ? (now - s.lastConfirmAt) : null
    });
    if (ended.show) {
      view = { kind: 'ended', label: 'Ended', detail: endReasonText(host.lastEndReason), watching: 0 };
    }

    // Keep the account-menu "Present this job" item in sync BEFORE the idle-hide
    // early return below can skip the rest of this function.
    syncMenuBtn(view, jobId);

    // A room running on ANOTHER record still has to be visible (host.elsewhere).
    // The idle start button moved to the account menu, so an idle strip now has
    // nothing of its own to show — hide it in every idle case EXCEPT the
    // elsewhere warning. (Previously this kept the strip up whenever jobId was
    // set, purely to paint the now-relocated Present button.)
    if (view.kind === 'idle' && !host.elsewhere) { el.style.display = 'none'; return; }
    el.style.display = '';
    el.setAttribute('data-state', view.kind);

    var html = '';
    if (view.kind === 'idle') {
      // The "Present" start button moved to the account menu (#present-menu-btn,
      // synced by syncMenuBtn above). We only reach this idle branch when
      // host.elsewhere is set — the idle-hide guard returned otherwise — so the
      // strip here exists purely to carry the "different record" warning below.
      // Named, not joined. This tab must not take the host row of a room for a
      // record it is not looking at — that is the supersede that killed the
      // presenting tab and pointed every guest at "not shared".
      if (host.elsewhere) {
        html += '<div class="p86-live-warn">' + esc(host.elsewhere === 1
          ? "You're presenting a different record. Open it to see that session."
          : "You're presenting " + host.elsewhere + " other records. Open one to see that session.") + '</div>';
      }
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
      // THE STATE THE PRESENTER COULD NOT SEE. Every guest was being told, in
      // words, that the host was on a different record; the host's own strip
      // said "LIVE · 1 watching" and nothing else. Read from the host's own
      // `view` echo — a report, never a command: nothing here navigates.
      // WHICH ARRANGEMENT IS RUNNING, always visible, never behind a click.
      // The host chooses mirror-vs-structured, sees which one is live, and the
      // guest bar says which they are getting; a presenter who thinks he is
      // sending a filtered view while sending pixels is the outcome this is
      // here to make impossible.
      html += '<span class="p86-live-mode" data-mode="' + esc(host.mode) + '">' +
              esc(host.mode === 'mirror' ? 'MIRRORING' : 'SHARED VIEW') +
              (view.kind === 'live' && s && s.hostView && s.hostView.surface
                ? ' &middot; ' + esc(surfaceLabel(s.hostView.surface)) : '') +
              '</span>';
      var mirror = mirrorNotice(s ? s.hostView : null, view.watching);
      if (mirror) html += '<div class="p86-live-warn">' + esc(mirror) + '</div>';
      // The mirror's own refusal, which is a DIFFERENT fact from the room's:
      // the room may be perfectly happy with this surface while the mirror
      // declines to send pixels for it, and in that case the viewers are still
      // getting the structured document rather than nothing.
      if (host.mode === 'mirror') {
        var ms = mirrorStatus();
        if (ms.reason) {
          var C2 = window.p86LiveMirrorCore;
          var t = (C2 && C2.REFUSAL_TEXT && C2.REFUSAL_TEXT[ms.reason]) || '';
          if (t) html += '<div class="p86-live-warn">' + esc(t) + '</div>';
        }
        if (ms.degraded) {
          html += '<div class="p86-live-warn">Your screen is busy — viewers are getting an update every few seconds instead of live.</div>';
        }
      }
      if (s && s.multiInstance) {
        html += '<div class="p86-live-warn">This session keeps moving between servers — some viewers may be seeing a different room.</div>';
      }
      if (el.classList.contains('is-open')) html += panelHtml(s);
    }
    // Repainted on a 1Hz tick, so only write when something actually changed:
    // an unconditional innerHTML would blow away focus on the panel's toggle
    // and make the viewer link impossible to select by hand.
    if (html !== host._html) { host._html = html; el.innerHTML = html; }
  }

  // ── The presenter panel ────────────────────────────────────────────────
  // The strip's `is-open` state, grown into the panel. Same element, same
  // delegation, same 1Hz repaint — and still body-fixed, because
  // workspace-layout.js sets .job-detail-header to display:none
  // unconditionally, so anything mounted in the job header is invisible.
  function surfaceLabel(key) {
    var s = host.session;
    var list = (s && s.surfaces) || [];
    for (var i = 0; i < list.length; i++) if (list[i].key === key) return list[i].label;
    return key || '';
  }

  function durationText(iso) {
    var t = Date.parse(iso);
    if (!isFinite(t)) return '';
    var mins = Math.max(0, Math.round((Date.now() - t) / 60000));
    if (mins < 1) return 'just joined';
    if (mins < 60) return 'watching ' + mins + ' min';
    var h = Math.floor(mins / 60);
    return 'watching ' + h + 'h ' + (mins % 60) + 'm';
  }

  function panelHtml(s) {
    if (!s) return '';
    var out = '<div class="p86-live-panel">';

    // The link, in full. A host in a meeting sometimes reads it aloud, and a
    // credential you cannot see is one you cannot audit.
    if (host.token) {
      var url = location.origin + '/live/' + host.token;
      out += '<div class="p86-live-linkrow">' +
             '<code class="p86-live-link">' + esc(url) + '</code>' +
             '<button type="button" class="p86-live-btn is-ghost" data-live-act="copy">Copy</button>' +
             '</div>';
    }

    // Exactly WHEN the link stops working — a clock time and a countdown. Not
    // "expires in 8 hours": that is not a time anyone can plan around.
    if (s.room && s.room.expires_at && window.p86LiveView) {
      out += '<div class="p86-live-meta">' + esc(window.p86LiveView.expiryText(s.room.expires_at)) + '</div>';
    }

    // ── The arrangement, chosen and stated ────────────────────────────────
    // Two modes, one switch, and the switch says what each one DOES rather than
    // naming it. Mirroring is the one change in this feature that widens what a
    // link-holder can see, so it is confirmed in those words and never flipped
    // on a stray tap.
    var mirroring = host.mode === 'mirror';
    out += '<div class="p86-live-toggle">' +
           '<button type="button" class="p86-live-switch' + (mirroring ? ' is-on' : '') + '" ' +
             'role="switch" aria-checked="' + (mirroring ? 'true' : 'false') + '" ' +
             'data-live-act="mode" data-mode="' + (mirroring ? 'projected' : 'mirror') + '">' +
             '<span class="p86-live-switch-knob"></span>' +
             '<span class="p86-live-switch-label">Show my actual screen</span>' +
           '</button>' +
           '<div class="p86-live-meta">' + (mirroring
             ? 'Viewers see this screen exactly as you see it, including every figure on it.'
             : 'Viewers see a structured version the server builds from the record.') +
           '</div>';
    if (mirroring) {
      // WHAT THEY CAN SEE, generated from the list the serializer actually
      // enforces. Typing this out beside the denylist is how a promise on
      // screen outlives the code that kept it.
      var CM = window.p86LiveMirrorCore;
      var mine = (s.mirrorSurfaces || []).map(surfaceLabel).filter(Boolean).join(', ');
      out += '<div class="p86-live-meta">Mirrored screens: ' + esc(mine || 'none') + '. ' +
             'Every other screen falls back to the structured version.</div>';
      if (CM && CM.notSharedText) {
        out += '<div class="p86-live-meta">They never see: ' + esc(CM.notSharedText()) + '.</div>';
      }
      out += '<div class="p86-live-meta">Photos already load from a public link, so a viewer who saves one keeps it after this session ends.</div>';
    }
    out += '</div>';

    // The toggle. The label states the MECHANISM, because the mechanism IS the
    // feature — it is what separates this from a CSS blur someone can peel off
    // in dev tools. No blur language anywhere.
    //
    // Absent in mirror mode, and absent rather than disabled: the server refuses
    // it there (a mirrored room streaming pixels cannot also claim to hide
    // financials), and a control that is present but always refused teaches
    // people the surface lies.
    var hidden = host.hideFinancials !== false;
    if (!mirroring) out += '<div class="p86-live-toggle">' +
           '<button type="button" class="p86-live-switch' + (hidden ? ' is-on' : '') + '" ' +
             'role="switch" aria-checked="' + (hidden ? 'true' : 'false') + '" ' +
             'data-live-act="policy" data-hide="' + (hidden ? '0' : '1') + '">' +
             '<span class="p86-live-switch-knob"></span>' +
             '<span class="p86-live-switch-label">Hide financials</span>' +
           '</button>' +
           '<div class="p86-live-meta">' + (hidden
             ? 'The server does not send margins, cost or contract values to viewers.'
             : 'Viewers can see margins, cost and contract values.') + '</div>' +
           '</div>';

    // The watcher list.
    var st = s.state();
    var list = visibleParticipants(s.participants, st);
    out += '<div class="p86-live-roster' + (st.dim ? ' is-dim' : '') + '">';
    if (st.message) out += '<div class="p86-live-roster-note">' + esc(st.message) + '</div>';
    if (!st.showRoster) {
      out += '</div>';
    } else if (!list.length) {
      out += '<div class="p86-live-roster-note">Nobody is watching yet.</div></div>';
    } else {
      for (var i = 0; i < list.length; i++) {
        var p = list[i];
        var where = '';
        if (p.role !== 'host') {
          // What each viewer is looking at. A SAFETY property, not decoration:
          // it tells the host someone stopped following BEFORE he says "as you
          // can see here". Observed from their own fetch, never self-reported.
          // Three situations, not one sentence. "not loaded yet" was printed
          // for all of them, including the case where there is NOTHING to load
          // because the host's own screen is not being mirrored — which reads
          // as a broken viewer and sends the host looking for the fault at the
          // wrong end of the room.
          where = esc(viewerWhere(p, s.hostView && s.hostView.surface, surfaceLabel(p.surface), Date.now()));
        }
        out += '<div class="p86-live-row' + (p.presence === 'stale' ? ' is-stale' : '') + '">' +
               '<span class="p86-live-who">' + esc(p.name) + (p.guest ? ' <em>guest</em>' : '') +
                 (where ? '<span class="p86-live-where">' + where + '</span>' : '') +
                 (p.joined_at && p.role !== 'host' ? '<span class="p86-live-where">' + esc(durationText(p.joined_at)) + '</span>' : '') +
               '</span>' +
               (p.presence === 'stale' ? '<span class="p86-live-flag">not responding</span>' : '') +
               (p.role === 'host' ? '<span class="p86-live-flag">host</span>' :
                 '<span class="p86-live-acts">' +
                 '<button type="button" data-live-act="kick" data-pid="' + esc(p.id) + '">Remove</button>' +
                 '<button type="button" data-live-act="kick" data-pid="' + esc(p.id) + '" data-revoke="1">Remove &amp; revoke link</button>' +
                 '</span>') +
               '</div>';
      }
      out += '</div>';
    }

    // Stated PERMANENTLY, not only inside a confirm dialog someone dismisses
    // on reflex. A kick kills the session, not the link; the API says so in
    // words and the surface must not claim more.
    out += '<div class="p86-live-standing">Removing someone ends their session. ' +
           'They still hold the link — revoking is the removal that holds.</div>';

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
      host.mode = res.body.mode === 'mirror' ? 'mirror' : 'projected';
      host.hideFinancials = res.body.hide_financials !== false;
      attachSession(res.body.token, true);
      copyLink();
      // Send where the host already is, immediately, so the first guest to
      // arrive is not looking at a default while he talks about something else.
      pushRoute();
    }).catch(function () { toast('Could not start the live session.'); });
  }

  function attachSession(token, isHostSurface) {
    // THE HOST SURFACE MUST NEVER ATTACH FROM A GUEST PAGE. isGuestPage() gates
    // boot(), but attachSession is also reachable through
    // window.p86Live.startForJob and through adoptExistingRooms, and this
    // feature has now had two host/guest bleeds. One gate at one entry point is
    // how the second one happened, so the refusal lives at the door that
    // actually takes the host row.
    if (isGuestPage()) { try { console.warn('[live] refusing to host from a guest page'); } catch (e) {} return; }
    if (host.session) host.session.stop('restart');
    host.token = token;
    var s = new LiveSession({
      token: token, host: isHostSurface,
      onChange: function () { paintStrip(); host.layer.render(s); }
    });
    host.session = s;
    s.start();
    // The mirror follows the SESSION, and it stops the instant the session
    // does. A serializer left running against a terminated room is the same
    // class of defect as a strip that flips back to "Present" while the host
    // goes on talking.
    syncMirror();
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

  // Native confirm() returns undefined inside an installed PWA, so every
  // `if (!confirm(x)) return` guard silently does nothing there: the dialog
  // never appears and the action never runs. Kick was therefore broken on the
  // one device this feature is mostly used from. p86Confirm is the in-app
  // overlay; native is the fallback for a plain browser tab.
  function ask(message, confirmLabel) {
    if (typeof window.p86Confirm === 'function') {
      return window.p86Confirm({
        title: 'Confirm', message: message,
        confirmLabel: confirmLabel, confirmText: confirmLabel,
        cancelLabel: 'Cancel', cancelText: 'Cancel',
        danger: true, destructive: true
      });
    }
    return Promise.resolve(window.confirm(message));
  }

  function kickParticipant(pid, revoke) {
    var s = host.session;
    if (!s || !s.roomId || !pid) return;
    var msg = revoke
      ? 'Revoke the link?\n\nThis ends the session for everyone and the link stops working.'
      : 'Remove this person from the session?\n\nThey still hold the link and can rejoin. Use "Remove & revoke link" to stop that.';
    ask(msg, revoke ? 'Revoke link' : 'Remove').then(function (ok) {
      if (!ok) return;
      fetch('/api/live/rooms/' + encodeURIComponent(s.roomId) + '/kick', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ participant_id: pid, revoke: !!revoke })
      }).then(function (r) { return r.json(); })
        // The server's own sentence, verbatim. Never a second copy: the door
        // states the honest limitation and the surface must not soften it.
        .then(function (j) { if (j && j.note) toast(j.note); })
        .catch(function () { toast('Could not remove that participant.'); });
    });
  }

  function setHideFinancials(hide) {
    var s = host.session;
    if (!s || !s.roomId) return;
    fetch('/api/live/rooms/' + encodeURIComponent(s.roomId) + '/policy', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin', cache: 'no-store',
      body: JSON.stringify({ hide_financials: !!hide })
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
      // The local flag follows the SERVER's answer, never the click. Nothing is
      // hidden or revealed until the row changes, so a panel that flipped
      // optimistically would be claiming a redaction that had not happened.
      .then(function (res) {
        if (!res.ok) { toast((res.body && res.body.error) || 'Could not change what viewers can see.'); return; }
        host.hideFinancials = !!res.body.hide_financials;
        if (res.body.note) toast(res.body.note);
        paintStrip();
      })
      .catch(function () { toast('Could not change what viewers can see.'); });
  }

  // ── Mode ────────────────────────────────────────────────────────────────
  // The mirror engine is STARTED AND STOPPED FROM THE SERVER'S ANSWER, never
  // from the click. Nothing is mirrored until the row says mirror, for the same
  // reason nothing is hidden until the row says hidden: the row is where the
  // arrangement lives, and a client that flipped optimistically would be
  // claiming an arrangement that had not happened.
  function syncMirror() {
    var M = window.p86LiveMirror;
    if (!M) return;
    var s = host.session;
    if (host.mode === 'mirror' && s && !s.terminal && s.roomId) M.start(s);
    else M.stop();
  }

  function mirrorStatus() {
    try { return (window.p86LiveMirror && window.p86LiveMirror.status()) || {}; }
    catch (e) { return {}; }
  }

  function setMode(mode) {
    var s = host.session;
    if (!s || !s.roomId) return;
    var next = mode === 'mirror' ? 'mirror' : 'projected';
    var ask2 = next === 'mirror'
      ? 'Show viewers your actual screen?\n\nThey will see this screen exactly as you see it, including every figure on it. Screens that cannot be mirrored fall back to the structured view.'
      : 'Go back to the structured view?\n\nViewers stop seeing your screen immediately.';
    ask(ask2, next === 'mirror' ? 'Show my screen' : 'Use structured view').then(function (ok) {
      if (!ok) return;
      fetch('/api/live/rooms/' + encodeURIComponent(s.roomId) + '/mode', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin', cache: 'no-store',
        body: JSON.stringify({ mode: next })
      }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
        .then(function (res) {
          if (!res.ok) { toast((res.body && res.body.error) || 'Could not change how viewers see this.'); return; }
          host.mode = res.body.mode === 'mirror' ? 'mirror' : 'projected';
          host.hideFinancials = !!res.body.hide_financials;
          if (res.body.note) toast(res.body.note);
          syncMirror();
          paintStrip();
        })
        .catch(function () { toast('Could not change how viewers see this.'); });
    });
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
        if (!j || !Array.isArray(j.rooms)) return;
        host.mine = j.rooms;
        host.mineUntil = Date.now() + MINE_REFRESH_MS;
        tryAdopt();
      }).catch(function () {});
  }

  // An unadopted claim is re-checked against the server rather than trusted
  // from boot: "you're presenting a different record" must stop being said when
  // that room ends, and this tab has no stream on it to hear that from.
  var MINE_REFRESH_MS = 60000;
  function refreshMineIfStale() {
    if (host.session && !host.session.terminal) return;
    if (!host.mine && !host.elsewhere) return;
    if (Date.now() < host.mineUntil) return;
    host.mineUntil = Date.now() + MINE_REFRESH_MS;
    adoptExistingRooms();
  }

  // Adopt only a room for the record THIS tab is looking at. Anything else is
  // COUNTED and named, never joined: joining it takes the room's one host row,
  // supersedes the tab that is really presenting, and then reports a foreign
  // record on every beat — which is how a working session starts telling every
  // guest "he is on a different record" and hands them nothing to load.
  function tryAdopt() {
    if (!host.mine) return;
    if (host.session && !host.session.terminal) { host.elsewhere = 0; return; }
    var v = adoptionVerdict(host.mine, captureHostRoute());
    host.elsewhere = v.elsewhere;
    if (!v.adopt) return;
    host.mine = null;
    host.elsewhere = 0;
    host.mode = v.adopt.mode === 'mirror' ? 'mirror' : 'projected';
    host.hideFinancials = v.adopt.hide_financials !== false;
    attachSession(v.adopt.token, true);
  }

  function wireCursorSampling() {
    // A COARSE pointer does not have a hover position — pointermove fires on
    // touch-DRAG, so a phone scrolling with a finger broadcasts a cursor trail
    // that means nothing. Gate the SENDING, not the receiving: this device
    // still shows everyone else's.
    try {
      if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) return;
    } catch (e) { /* no matchMedia: keep phase 01 behaviour */ }
    var last = 0;
    document.addEventListener('pointermove', function (ev) {
      var s = host.session;
      if (!s || s.terminal || !s.roomId) return;
      var now = Date.now();
      if (now - last < 100) return;   // 10 Hz sampling, shipped on the beat
      last = now;
      s.sampleCursor(ev.pageX, ev.pageY);
    }, { passive: true });
  }

  // THE GUEST PAGE MUST NOT BOOT THE HOST SURFACE.
  //
  // live.html loads this same file (it needs LiveSession and the pure core), and
  // phase 01's boot() ran unconditionally. On the guest page that meant:
  // stripEl() appended a HOST strip to the body, wireCursorSampling() bound a
  // document-level pointermove, and adoptExistingRooms() fired
  // GET /api/live/mine with credentials — so a SIGNED-IN visitor opening a
  // viewer link got their own room TOKENS delivered to the guest page, and
  // attachSession() then joined that room AS HOST from the guest tab.
  //
  // Which breaks the presenter's own app by ordinary QA behaviour: the first
  // thing anyone does after clicking Present is open the link they just copied.
  // That second host join trips the one-host-row supersede rule, writes
  // `superseded` to the PRESENTING tab and terminates it — and in phase 02 the
  // presenting tab is the mirror source, so the room then dies at the 120s
  // host-beat backstop.
  //
  // The gate is here rather than in live.html because it must hold for any
  // future page that loads this file for its core.
  function isGuestPage() {
    try { return String(location.pathname || '').indexOf('/live/') === 0; }
    catch (e) { return false; }
  }

  function boot() {
    if (isGuestPage()) return;
    stripEl();
    wireMenuBtn();
    wireCursorSampling();
    adoptExistingRooms();
    // Repaint on a timer as well as on events: "can't confirm" is a state
    // reached by the ABSENCE of news, so nothing will fire an event to
    // announce it.
    host._tick = setInterval(function () {
      try {
        tryAdopt(); refreshMineIfStale();
        paintStrip(); pushRoute();
        // The mirror's frame outline rides THIS tick rather than a rAF loop or
        // a scroll listener: the pane sits inside an inner scroller and
        // tracking it live would mean a forced synchronous layout per frame on
        // the presenter's own page. One measurement a second is enough for a
        // box that only moves when the window does, and it costs the host
        // nothing that the strip repaint was not already costing.
        if (window.p86LiveMirror) window.p86LiveMirror.tick();
        // A session that died must not leave a serializer running.
        if (host.mode === 'mirror' && (!host.session || host.session.terminal)) syncMirror();
        if (host.session) host.layer.render(host.session);
      } catch (e) {}
    }, 1000);
    // The route is read on the 1Hz tick AND right after any click. The tick is
    // the backstop that matters: history.pushState fires no event, and the
    // router wraps a fixed list of nav functions — an unwrapped navigation path
    // would silently freeze the mirror with no error anywhere. The click hook
    // is what makes the common case land in under a second instead of up to
    // one. Both are free; neither couples this file to js/router.js, which
    // other work is editing.
    document.addEventListener('click', function () {
      setTimeout(pushRoute, 160);
      setTimeout(pushRoute, 500);
    }, true);
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
    current: function () { return host.session; },
    // The host's claimed route, unfiltered, for the mirror to attach to EVERY
    // flush. Exposed rather than reimplemented so there is one reader of the
    // DOM's nav state and not two that disagree — and it is still reported AS
    // FOUND: the server decides what is inside the room, because a client that
    // filtered its own route would be the authorization.
    route: captureHostRoute,
    mode: function () { return host.mode; }
  };
})();
