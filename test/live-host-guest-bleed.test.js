// Live Rooms — THE HOST/GUEST BLEED, and the states the presenter could not see.
//
// Reported live, 2026-08-19, by the host mid-presentation: "it's saying I'm on
// a different record" and "my screen is read only", with one viewer stuck at
// "not loaded yet" on his own panel.
//
// WHAT THE TRACE ACTUALLY FOUND, because it is the reason this suite is shaped
// the way it is: there is NO mechanism anywhere in this feature that can make
// the presenter's own app read-only. The literal string "read-only" occurs
// twice in the entire client and both are in live.html, the guest document.
// The app's own read-only mode has exactly one setter (js/jobs.js, from
// job._canEdit) and nothing here touches it. So the last describe block is a
// standing assertion of that ABSENCE — the presenter's app must keep gaining
// nothing but an overlay, and if that ever stops being true the build says so
// instead of a host discovering it in front of a client.
//
// The three defects that ARE real, all of them one bleed between the host
// surface and the guest surface:
//
//   1. adoption picked rooms[0] with no regard for the record on screen, so an
//      ordinary second tab took the room's one host row, superseded the tab
//      that was really presenting, and then reported a foreign record on every
//      beat — which is exactly the "different record" every guest was shown.
//   2. the host's own `view` echo, which carries the server's verdict, was
//      stored and read nowhere: every guest was told the mirror was dark and
//      the presenter was told "LIVE · 1 watching".
//   3. a terminated host session could not reach its own Ended notice, so
//      every way a room dies flipped the strip silently back to "Present".
//
// Plus the roster wording that blamed the viewer for the host's own state.

const fs = require('fs');
const path = require('path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

// Assertions about what the code REFUSES to do run against code, not prose:
// these files explain their own refusals at length, and a naive grep would fail
// on the explanation rather than the defect — which teaches the next person to
// delete the comment instead of the bug.
const stripJs = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const stripHtml = (s) => stripJs(s.replace(/<!--[\s\S]*?-->/g, ''));
const code = (...p) => stripJs(read(...p));

const C = require('../js/live-rooms.js');

// ══ 1. Adoption is a MATCH, not a pick ═════════════════════════════════════

describe('a tab adopts only a room for the record it is looking at', () => {
  const roomFor = (id, token) => ({ entity_type: 'job', entity_id: id, token: token, hide_financials: true });
  const onJob = (id) => ({ entity_type: 'job', entity_id: id, surface: 'job-overview' });

  test('the matching room is adopted even when it is not the newest', () => {
    // /api/live/mine is ORDER BY created_at DESC and returns every room this
    // user hosts. rooms[0] is the newest, not the relevant one.
    const v = C.adoptionVerdict([roomFor('B', 'tB'), roomFor('A', 'tA')], onJob('A'));
    expect(v.adopt.token).toBe('tA');
    expect(v.elsewhere).toBe(1);
  });

  test('a room for another record is COUNTED, never adopted', () => {
    // This is the defect exactly: taking this room joins as host, supersedes
    // the presenting tab, and then beats a foreign record forever.
    const v = C.adoptionVerdict([roomFor('B', 'tB')], onJob('A'));
    expect(v.adopt).toBeNull();
    expect(v.elsewhere).toBe(1);
  });

  test('a tab that is not on a record adopts nothing at all', () => {
    // captureHostRoute returns all-null off the job page. Adopting there is how
    // a tab sitting on the Leads list took over a presentation.
    for (const route of [null, {}, { entity_type: 'job', entity_id: null }, { entity_type: null, entity_id: 'A' }, { entity_type: 'job', entity_id: '' }]) {
      const v = C.adoptionVerdict([roomFor('A', 'tA')], route);
      expect(v.adopt).toBeNull();
      expect(v.elsewhere).toBe(1);
    }
  });

  test('the entity id is compared as a STRING, so 7 and "7" are the same record', () => {
    // job ids arrive as numbers from appState and as text from the room row.
    // A === on mixed types would refuse the host's own room forever, which
    // presents as "adoption is broken" rather than as a type bug.
    const v = C.adoptionVerdict([{ entity_type: 'job', entity_id: 7, token: 't7' }], { entity_type: 'job', entity_id: '7' });
    expect(v.adopt.token).toBe('t7');
    expect(v.elsewhere).toBe(0);
  });

  test('nothing hosted means nothing claimed', () => {
    expect(C.adoptionVerdict([], onJob('A'))).toEqual({ adopt: null, elsewhere: 0 });
    expect(C.adoptionVerdict(null, onJob('A'))).toEqual({ adopt: null, elsewhere: 0 });
  });

  test('the client actually routes adoption through it, and joins nothing else', () => {
    const SRC = code('js', 'live-rooms.js');
    // The shape that shipped: rooms[0], with no comparison to anything.
    expect(SRC).not.toMatch(/attachSession\(\s*j\.rooms\[0\]/);
    expect(SRC).not.toMatch(/rooms\[0\]\.token/);
    expect(SRC).toMatch(/adoptionVerdict\(host\.mine,\s*captureHostRoute\(\)\)/);
  });
});

// ══ 2. The host is told what his viewers can see ═══════════════════════════

describe("the presenter is told when his viewers can't see him", () => {
  test('each refusal is named, in the presenter\'s own terms', () => {
    // The three the server can return. The guest bar has said these since
    // phase 02; the host's strip said nothing at all.
    expect(C.mirrorNotice({ surface: null, reason: 'off_room' }, 1)).toMatch(/different record/);
    expect(C.mirrorNotice({ surface: null, reason: 'not_shared' }, 1)).toMatch(/isn't one of the shared screens/);
    expect(C.mirrorNotice({ surface: null, reason: 'away' }, 1)).toMatch(/left the job/);
  });

  test('it counts the people it is speaking for', () => {
    expect(C.mirrorNotice({ surface: null, reason: 'off_room' }, 0)).toMatch(/^Viewers/);
    expect(C.mirrorNotice({ surface: null, reason: 'off_room' }, 1)).toMatch(/^Your viewer/);
    expect(C.mirrorNotice({ surface: null, reason: 'off_room' }, 3)).toMatch(/^Your 3 viewers/);
  });

  test('a shared surface says nothing — a warning that is always on is not a warning', () => {
    expect(C.mirrorNotice({ surface: 'job-overview', reason: null }, 2)).toBe('');
    expect(C.mirrorNotice({ surface: 'job-wip-report', reason: 'off_room' }, 2)).toBe('');
  });

  test('before the first verdict it claims nothing', () => {
    // hostView starts { surface: null, reason: null }. Warning there would be
    // the strip claiming more than it knows, which is the rule this whole
    // feature is built around.
    expect(C.mirrorNotice({ surface: null, reason: null }, 1)).toBe('');
    expect(C.mirrorNotice(null, 1)).toBe('');
    expect(C.mirrorNotice(undefined, 0)).toBe('');
  });

  test('the strip actually paints it, from the host session', () => {
    const SRC = code('js', 'live-rooms.js');
    expect(SRC).toMatch(/mirrorNotice\(s \? s\.hostView : null/);
  });
});

// ══ 3. THE ECHO IS A REPORT, NEVER A COMMAND ═══════════════════════════════

describe('the host does not apply his own mirrored view', () => {
  // The host DOES receive his own `view` frames: emit() passes `except` for
  // cursors and not for view, and projectEvent rebuilds view identically for
  // every recipient. That echo is now load-bearing — it is where mirrorNotice
  // reads the verdict — so the rule that it must not MOVE him needs an
  // assertion of its own rather than resting on nobody having written the call.
  test('a view frame moves hostView and nothing else', () => {
    const S = { hostView: { surface: 'job-overview', reason: null }, lastSeq: 0, _changed() { this.changed = true; } };
    const proto = Object.create(null);
    // Drive the real handler against a bare object: anything it touches beyond
    // the mirror fields shows up as a new key.
    const before = new Set(Object.keys(S));
    const handle = requireHandle();
    handle.call(S, { type: 'view', seq: 4, surface: null, reason: 'off_room' });
    expect(S.hostView).toEqual({ surface: null, reason: 'off_room' });
    const added = Object.keys(S).filter((k) => !before.has(k));
    // lastFrameAt and lastSeq are freshness bookkeeping; `changed` is the
    // repaint. A document, a surface, or a route would be a navigation.
    expect(added.sort()).toEqual(['changed', 'lastFrameAt']);
    expect(proto).toEqual({});
  });

  test('the host client never fetches the guest read proxy', () => {
    // The one door that returns a DOCUMENT. If the host surface ever calls it,
    // the presenter's own page has started rendering the guest projection of
    // the room's record — which is a read-only copy of a record he may not even
    // be on. That is the failure both of his symptoms would look like.
    const SRC = code('js', 'live-rooms.js');
    const host = SRC.slice(SRC.indexOf('══ HOST STRIP'));
    expect(host).not.toMatch(/\/view\//);
    expect(host).not.toMatch(/loadSurface|View\.render|hostView\.surface\s*\)/);
  });

  test('the host surface refuses to attach from a guest page', () => {
    // isGuestPage() gates boot(), but attachSession is also reachable through
    // window.p86Live.startForJob and through adoption. One gate at one entry
    // point is how the SECOND bleed happened.
    const SRC = code('js', 'live-rooms.js');
    const fn = SRC.slice(SRC.indexOf('function attachSession'));
    const body = fn.slice(0, fn.indexOf('function endHosting'));
    expect(body).toMatch(/if \(isGuestPage\(\)\)[\s\S]{0,120}return;/);
    // And it is refused BEFORE the old session is torn down: returning after
    // stop() would leave the presenter with no session at all.
    expect(body.indexOf('isGuestPage')).toBeLessThan(body.indexOf("stop('restart')"));
  });

  function requireHandle() {
    // js/live-rooms.js exports only the pure core in Node — the engine lives
    // behind `if (typeof window === 'undefined') return`. Rather than stand up
    // a DOM, lift the one prototype method under test out of the source.
    const SRC = read('js', 'live-rooms.js');
    const start = SRC.indexOf('LiveSession.prototype._handle = function');
    const end = SRC.indexOf('LiveSession.prototype._pruneCursors');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = SRC.slice(start, end).replace('LiveSession.prototype._handle = ', 'return ');
    // resumeVerdict is the only Core reference inside it.
    return new Function('resumeVerdict', body)(C.resumeVerdict);
  }
});

// ══ 4. A viewer with no document, told apart from a viewer in trouble ══════

describe('"not loaded yet" said three different things at once', () => {
  const joined = (msAgo) => new Date(Date.now() - msAgo).toISOString();

  test('when the host is not being mirrored, there is NOTHING to load', () => {
    // The guest never fetches when hostView.surface is null — followHost()
    // returns before the request — so h.at is never set and every viewer read
    // "not loaded yet". That blames the viewer for the host's own state and
    // sends him looking for the fault at the wrong end of the room.
    const w = C.viewerWhere({ surface: null, joined_at: joined(60000) }, null, null, Date.now());
    expect(w).toMatch(/nothing to show/);
    expect(w).not.toMatch(/not loaded/);
  });

  test('a viewer who just arrived is loading, not failing', () => {
    expect(C.viewerWhere({ surface: null, joined_at: joined(2000) }, 'job-overview', null, Date.now())).toBe('loading…');
  });

  test('a viewer still empty long after joining is reported as FAILING', () => {
    // The state the host had no way to see: a guest whose boot never completed
    // sat in the roster looking identical to one that had just arrived.
    const w = C.viewerWhere({ surface: null, joined_at: joined(C.VIEWER_LOAD_GRACE_MS + 5000) }, 'job-overview', null, Date.now());
    expect(w).toMatch(/hasn't loaded/);
    expect(w).toMatch(/not be getting through/);
  });

  test('a viewer who is reading something says what, and whether it is yours', () => {
    expect(C.viewerWhere({ surface: 'job-wip-report', following: true }, 'job-wip-report', 'WIP', Date.now())).toBe('WIP');
    expect(C.viewerWhere({ surface: 'job-overview', following: false }, 'job-wip-report', 'Overview', Date.now())).toBe('broke off — Overview');
  });

  test('the panel routes every viewer row through it', () => {
    const SRC = code('js', 'live-rooms.js');
    expect(SRC).not.toMatch(/'not loaded yet'/);
    expect(SRC).toMatch(/viewerWhere\(p,\s*s\.hostView && s\.hostView\.surface/);
  });
});

// ══ 5. A session that stopped SAYS it stopped ══════════════════════════════

describe('every way a room dies reaches the Ended notice', () => {
  test('a terminal session shows Ended, and holds it', () => {
    const first = C.endedNoticeVerdict({ terminal: true, endedUntil: 0, now: 1000 });
    expect(first.show).toBe(true);
    expect(first.until).toBe(1000 + C.ENDED_STICKY_MS);
    expect(first.release).toBe(false);
    // Still up a moment later, on the same deadline rather than a new one.
    const held = C.endedNoticeVerdict({ terminal: true, endedUntil: first.until, now: 5000 });
    expect(held.show).toBe(true);
    expect(held.until).toBe(first.until);
  });

  test('when the notice expires the session is RELEASED, which re-arms the next one', () => {
    // Without the release, endedUntil stays set forever and the `!endedUntil`
    // guard means the SECOND end of the day shows nothing at all.
    const done = C.endedNoticeVerdict({ terminal: true, endedUntil: 11000, now: 11000 });
    expect(done.show).toBe(false);
    expect(done.until).toBe(0);
    expect(done.release).toBe(true);
    // And from released state, a fresh terminal arms it again.
    expect(C.endedNoticeVerdict({ terminal: true, endedUntil: 0, now: 90000 }).show).toBe(true);
  });

  test('a healthy session shows nothing and releases nothing', () => {
    expect(C.endedNoticeVerdict({ terminal: false, endedUntil: 0, now: 1000 }))
      .toEqual({ show: false, until: 0, release: false });
  });

  test('the strip is not gated on the session being absent', () => {
    // THE ACTUAL BUG. `host.session` is only ever assigned, never nulled, so
    // `if (!s && host.endedUntil)` could not run — and hostStripState was fed
    // `hosting: !!(s && !s.terminal)`, which made its own terminal branch dead
    // too. Both halves said Ended; neither could be reached.
    const SRC = code('js', 'live-rooms.js');
    expect(SRC).not.toMatch(/if \(!s && host\.endedUntil/);
    expect(SRC).toMatch(/endedNoticeVerdict\(\{ terminal: !!\(s && s\.terminal\)/);
    expect(SRC).toMatch(/if \(ended\.release\)/);
  });

  test('a superseded host is told which of the six paths it took', () => {
    expect(C.endReasonText('superseded')).toMatch(/another tab/);
    expect(C.endReasonText('role_refused')).toMatch(/Reload to watch/);
  });
});

// ══ 6. THE PRESENTER'S APP GAINS NOTHING BUT AN OVERLAY ════════════════════

describe('the host document is never read-only while presenting', () => {
  const LIVE_JS = code('js', 'live-rooms.js');
  const LIVE_CSS = read('css', 'live-rooms.css');

  test('the live client cannot reach the app\'s read-only mode', () => {
    // js/jobs.js toggles .read-only-mode from job._canEdit, which is computed
    // server-side. Nothing in this feature may touch that class, that flag, or
    // the job detail container.
    for (const forbidden of ['read-only-mode', '_canEdit', 'applyReadOnlyButtonGuard', 'readOnly']) {
      expect(LIVE_JS).not.toContain(forbidden);
    }
    expect(code('js', 'live-view.js')).not.toContain('read-only-mode');
    // The job detail container is READ, to tell whether a job page is open. It
    // is never held, styled, classed or disabled — the reference is a lookup
    // inside currentJobId() and nothing else.
    const refs = LIVE_JS.match(/jobs-job-detail-view/g) || [];
    expect(refs.length).toBe(1);
    expect(LIVE_JS).toMatch(/getElementById\('jobs-job-detail-view'\)/);
  });

  test('it disables nothing and inerts nothing on the host page', () => {
    expect(LIVE_JS).not.toMatch(/\.disabled\s*=/);
    expect(LIVE_JS).not.toMatch(/setAttribute\(\s*['"](inert|disabled)['"]/);
    expect(LIVE_JS).not.toMatch(/document\.body\.(className|style)/);
    expect(LIVE_JS).not.toMatch(/document\.body\.classList/);
    expect(LIVE_JS).not.toMatch(/documentElement\.(classList|style)/);
  });

  test('it mounts exactly two nodes on the host body, and both are bounded', () => {
    const mounts = LIVE_JS.match(/document\.body\.appendChild/g) || [];
    expect(mounts.length).toBe(2);
    expect(LIVE_JS).toMatch(/className = 'p86-live-strip'/);
    expect(LIVE_JS).toMatch(/className = 'p86-live-cursors'/);
  });

  test('THE CURSOR LAYER CANNOT SWALLOW A CLICK', () => {
    // It is sized to the full document height and sits over everything. Without
    // pointer-events:none it would make the presenter's entire app unclickable
    // the moment a viewer's cursor arrived — a read-only screen, appearing
    // exactly when someone joins.
    const layer = LIVE_CSS.slice(LIVE_CSS.indexOf('.p86-live-cursors'));
    const decl = layer.slice(0, layer.indexOf('}'));
    expect(decl).toMatch(/pointer-events:\s*none/);
    const cursor = LIVE_CSS.slice(LIVE_CSS.indexOf('.p86-live-cursor {'));
    expect(cursor.slice(0, cursor.indexOf('}'))).toMatch(/pointer-events:\s*none/);
    // And the strip is bounded rather than a full-viewport sheet.
    const strip = LIVE_CSS.slice(LIVE_CSS.indexOf('.p86-live-strip'));
    expect(strip.slice(0, strip.indexOf('}'))).not.toMatch(/(width|height):\s*100(vw|vh|%)/);
  });

  test('"read-only" is a GUEST claim and it lives only on the guest page', () => {
    // Both of the strings the host quoted are here, one line apart, and neither
    // can render in the app. If a future build moves either into the SPA, this
    // is the assertion that says so.
    const GUEST = stripHtml(read('live.html'));
    expect(GUEST).toMatch(/read-only/i);
    // Asserted on CODE, not on prose: these files explain at length why the
    // presenter must never be given a read-only shell, and a raw grep would
    // fail on the explanation — which teaches the next person to delete the
    // comment instead of the bug.
    for (const f of [['js', 'live-rooms.js'], ['js', 'live-view.js']]) {
      expect(code(...f)).not.toMatch(/\bread-only\b/i);
    }
    // The GUEST's sentence for the same fact names the host in the third
    // person — "John is on a different record — not shared" — and it comes from
    // live-view.js's renderer half, which index.html loads for expiryText and
    // must never render. The host is told the same fact in his own terms by
    // mirrorNotice; what must not happen is the app painting the guest bar.
    expect(code('js', 'live-view.js')).toMatch(/is on a different record — not shared/);
    const SRC = code('js', 'live-rooms.js');
    expect(SRC).not.toMatch(/is on a different record/);
    expect(SRC).not.toMatch(/reasonText|mirrorState|stampText|cellText/);
    // Exactly one function of the guest renderer is used by the app, and it
    // formats a clock time.
    const uses = SRC.match(/p86LiveView\.\w+/g) || [];
    expect(Array.from(new Set(uses))).toEqual(['p86LiveView.expiryText']);
  });

  test('the guest page asks for the viewer role, and asks for it on the join', () => {
    const GUEST = stripHtml(read('live.html'));
    expect(GUEST).toMatch(/asViewer:\s*true/);
    // Downgrade-only, sent on the one request that hands out a role.
    expect(LIVE_JS).toMatch(/as: this\.asViewer \? 'viewer' : undefined/);
    // And verified on the way back rather than merely requested.
    expect(LIVE_JS).toMatch(/self\.asViewer && j && j\.role === 'host'/);
    expect(LIVE_JS).toMatch(/_terminate\('role_refused'\)/);
  });

  test('the guest page still boots no host surface at all', () => {
    // Phase 02's gate, re-asserted: this is the leg that was fixed once and
    // came back one door lower.
    const SRC = code('js', 'live-rooms.js');
    const boot = SRC.slice(SRC.indexOf('function boot()'));
    expect(boot.slice(0, boot.indexOf('}'))).toMatch(/if \(isGuestPage\(\)\) return;/);
    const GUEST = stripHtml(read('live.html'));
    expect(GUEST).not.toMatch(/api\/live\/mine/);
    expect(GUEST).not.toMatch(/startForJob|p86Live\.startForJob/);
  });

  test('no shared same-origin surface carries viewer state to the host tab', () => {
    // Same browser means localStorage, sessionStorage, BroadcastChannel, a
    // service worker and postMessage are all shared between the presenting tab
    // and a viewer tab. If the guest shell ever writes "I am read-only"
    // anywhere shared, the host tab can read it. Today none of them are used —
    // and this is what keeps it that way.
    for (const f of [['js', 'live-rooms.js'], ['js', 'live-view.js']]) {
      const SRC = code(...f);
      expect(SRC).not.toMatch(/localStorage|sessionStorage|indexedDB|BroadcastChannel|postMessage/);
    }
    expect(stripHtml(read('live.html'))).not.toMatch(/localStorage|sessionStorage|indexedDB|BroadcastChannel|postMessage/);
    // And the service worker never caches or mediates the guest page.
    expect(read('sw.js')).toMatch(/\/live\//);
  });
});
