// Live Rooms phase 03 — MIRROR MODE, and the four claims the design got wrong.
//
// The mirror sends the presenter's actual pane instead of a rebuilt document.
// Everything below exists because a reviewer refuted a specific sentence of the
// design against the code as it actually is, and each describe block is one of
// those refutations turned into an assertion.
//
//   1. "The route already authorized it, so the mirror inherits tenancy."
//      FALSE. hostViewEvent runs on the BEAT (services/live-rooms.js BEAT_MS =
//      5000) and mutation flushes are ~50x faster; renderWipTab and
//      renderChangeOrders repaint the SAME element in place for a new job, so
//      the observer streams job B under job A's authorization for up to a beat.
//      The claim therefore rides EVERY flush and mirrorAuthorize re-decides
//      every time.
//
//   2. "The surface key IS the capture root's selector — no registry needed."
//      FALSE for job-cost-summary: grep finds it in server/services/
//      live-view.js:517, js/live-view.js:415 and three tests, and nowhere else.
//      There is no element with that id anywhere in the app, so
//      getElementById returns null. A registry is required.
//
//   3. "The mirror authorizes the same thing projected mode authorizes."
//      FALSE for job-overview, and by a wide margin: the same key resolves to a
//      fifteen-field document server-side and, in the DOM, to a pane carrying
//      the SUB CONTRACT ROSTER (js/jobs.js:5979-6030), vendor bills with aging
//      (js/jobs.js:3549-3593), invoices, the scope matrix, the task list with
//      assignee names, and the file tree. "They have access anyway" was said
//      about the owner-facing contract math, not about what AGX pays each trade
//      — and a forwarded link reaches people authenticated to nothing.
//
//   4. "Attribute copying is an allow-list, so ids cannot leak."
//      FALSE. An allow-list of NAMES does not filter VALUES, and this app puts
//      primary keys in them: data-co-open="<uuid>" (js/jobs.js:826),
//      data-co-new="<jobId>" (js/jobs.js:851) and id="schJobWxBody-<jobId>"
//      (js/schedule.js:3686) — the last two being the ROOM'S OWN entity_id,
//      which services/live-rooms.js:150 withholds by name and
//      routes/live-routes.js:166 names re-leaking as the regression to avoid.

const fs = require('fs');
const path = require('path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
// Assertions about what the code REFUSES to do run against CODE, not prose.
// These files explain their own refusals at length, and a naive grep fails on
// the explanation rather than the defect — which teaches the next person to
// delete the comment instead of the bug. Same helper as
// test/live-host-guest-bleed.test.js, for the same reason.
const stripJs = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const code = (...p) => stripJs(read(...p));

const LM = require('../server/services/live-mirror');
const LV = require('../server/services/live-view');
const L = require('../server/services/live-rooms');
const MC = require('../js/live-mirror-host');

const room = (over) => Object.assign({
  entity_type: 'job', entity_id: 'JOB-A', mode: 'mirror', hide_financials: false
}, over || {});

// ══ 1. TENANCY IS RE-DECIDED ON EVERY FLUSH ════════════════════════════════

describe('a mirror flush is authorized against the room row, every time', () => {
  const claim = (o) => Object.assign({ entity_type: 'job', entity_id: 'JOB-A', surface: 'job-wip-report' }, o || {});

  test('the room\'s own job on a mirrorable surface is authorized', () => {
    const gate = LM.mirrorAuthorize(LV.hostViewEvent(claim(), room()), 'mirror');
    expect(gate.ok).toBe(true);
    expect(gate.surface).toBe('job-wip-report');
    expect(gate.root).toBe('job-wip-report');
    expect(gate.reason).toBeNull();
  });

  test('A DIFFERENT JOB IS REFUSED, and named off_room', () => {
    // THE DEFECT. The host clicks another job; renderWipTab repaints the same
    // element with the new job's numbers and the observer is still attached.
    // Without this gate on the flush itself, those pixels ship under the old
    // room's authorization.
    const gate = LM.mirrorAuthorize(LV.hostViewEvent(claim({ entity_id: 'JOB-B' }), room()), 'mirror');
    expect(gate.ok).toBe(false);
    expect(gate.reason).toBe('off_room');
    expect(gate.surface).toBeNull();
    expect(gate.root).toBeNull();
  });

  test('leaving the job entirely is refused, and named away', () => {
    for (const bad of [null, {}, { entity_type: 'job' }, { entity_id: 'JOB-A' }, { entity_type: 'job', entity_id: '' }]) {
      const gate = LM.mirrorAuthorize(LV.hostViewEvent(bad, room()), 'mirror');
      expect(gate.ok).toBe(false);
      expect(gate.reason).toBe('away');
    }
  });

  test('a surface the ROOM does not serve is refused before the mirror sees it', () => {
    const gate = LM.mirrorAuthorize(LV.hostViewEvent(claim({ surface: 'job-details' }), room()), 'mirror');
    expect(gate.ok).toBe(false);
    expect(gate.reason).toBe('not_shared');
  });

  test('a projected room refuses every flush, whatever the claim says', () => {
    const gate = LM.mirrorAuthorize(LV.hostViewEvent(claim(), room({ mode: 'projected' })), 'projected');
    expect(gate.ok).toBe(false);
    expect(gate.reason).toBe('projected_mode');
  });

  test('the route the app really reports IS what gets claimed, unfiltered', () => {
    // A client that filtered its own route would be the authorization
    // (js/live-rooms.js:864). The mirror attaches captureHostRoute's raw answer
    // and lets the server refuse it.
    const SRC = read('js', 'live-mirror-host.js');
    expect(SRC).toMatch(/window\.p86Live\.route\(\)/);
    expect(read('js', 'live-rooms.js')).toMatch(/route: captureHostRoute/);
  });

  test('the route the server checks travels in the mirror body, not the beat', () => {
    const R = read('server', 'routes', 'live-routes.js');
    const start = R.indexOf("router.post('/:roomId/mirror/:streamKey'");
    expect(start).toBeGreaterThan(-1);
    const fn = R.slice(start, R.indexOf('// GET /api/live/:roomId/mirror', start));
    // The tenancy test, then the content test, then the discard.
    expect(fn).toMatch(/LV\.hostViewEvent\(body\.claim, ctx\.room\)/);
    expect(fn).toMatch(/LM\.mirrorAuthorize\(verdict, ctx\.room\.mode\)/);
    expect(fn.indexOf('LV.hostViewEvent')).toBeLessThan(fn.indexOf('clearMirror(h)'));
    // A ROLE check is not a TENANCY check, and the design conflated them. Both
    // are here, and the role one refuses at the door.
    expect(fn).toMatch(/ctx\.role !== 'host'[\s\S]{0,80}403/);
  });
});

// ══ 2. THE REGISTRY, BECAUSE THE KEY IS NOT THE SELECTOR ═══════════════════

describe('mirror roots come from a registry, not from the surface key', () => {
  test('job-cost-summary has no DOM element anywhere in the app', () => {
    // The refutation, re-proved from the tree rather than quoted.
    const html = read('index.html');
    expect(html).not.toMatch(/id=["']job-cost-summary["']/);
    expect(html).not.toMatch(/data-panel=["']job-cost-summary["']/);
    expect(read('js', 'workspace-layout.js')).not.toMatch(/'job-cost-summary'/);
  });

  test('and it is therefore refused BY NAME rather than silently', () => {
    const e = LM.mirrorEligibility('job-cost-summary');
    expect(e.ok).toBe(false);
    expect(e.reason).toBe('no_root');
    expect(e.root).toBeNull();
    // It still falls back to the structured document, which DOES exist for it.
    expect(LM.fallsBackToProjected('no_root')).toBe(true);
  });

  test('every mirrorable surface names a root that really exists in index.html', () => {
    const html = read('index.html');
    expect(LM.MIRROR_SURFACE_KEYS.length).toBeGreaterThan(0);
    for (const key of LM.MIRROR_SURFACE_KEYS) {
      const root = LM.MIRROR_SURFACES[key].root;
      expect(html).toContain('id="' + root + '"');
    }
  });

  test('every mirrorable surface is also a surface the ROOM serves', () => {
    // A pane the mirror will send but the room will not authorize is
    // unreachable; a pane the room authorizes that the mirror does not know
    // about falls through to `not_mirrorable`, which is fine. This is the
    // direction that must hold.
    for (const key of LM.MIRROR_SURFACE_KEYS) expect(LV.surfaceSpec(key)).toBeTruthy();
  });

  test('client and server agree on the list, or the build says so', () => {
    // Two lists that drift are how "what is captured" stops being knowable.
    expect(Object.keys(MC.MIRROR_ROOTS).sort()).toEqual(LM.MIRROR_SURFACE_KEYS.slice().sort());
    for (const key of LM.MIRROR_SURFACE_KEYS) {
      expect(MC.MIRROR_ROOTS[key]).toBe(LM.MIRROR_SURFACES[key].root);
    }
  });

  test('and on the sentence the host is shown for each refusal', () => {
    expect(MC.REFUSAL_TEXT).toEqual(LM.HOST_REFUSAL_TEXT);
  });
});

// ══ 3. job-overview IS NOT MIRRORED, AND THAT IS THE CONTENT DECISION ══════

describe('the mirror allow-list is narrower than the room\'s, on purpose', () => {
  test('job-overview is refused, and the reason names what is on it', () => {
    const e = LM.mirrorEligibility('job-overview');
    expect(e.ok).toBe(false);
    expect(e.reason).toBe('ledger');
    expect(LM.hostRefusalText('ledger')).toMatch(/sub contracts/i);
    expect(LM.hostRefusalText('ledger')).toMatch(/payables/i);
  });

  test('the pane really does carry what the refusal says it carries', () => {
    // Asserted against js/jobs.js rather than taken on trust: if a future build
    // moves the sub roster and the AP list off the overview, this test is where
    // the decision gets revisited instead of quietly outliving its reason.
    const JOBS = read('js', 'jobs.js');
    expect(JOBS).toMatch(/renderJobOverview/);
    expect(JOBS).toMatch(/data-bill-id=/);
    expect(JOBS).toMatch(/renderOverviewPhasesInto|renderJobSubsInto|subcontractor/i);
  });

  test('the Site Plan is refused as a DRAWING, not as an oversight', () => {
    const e = LM.mirrorEligibility('job-site-map');
    expect(e.ok).toBe(false);
    expect(e.reason).toBe('canvas');
    // And it does NOT fall back to a structured document, because there is no
    // Site Plan surface in services/live-view.js. Saying so is the honest
    // answer; showing buildings floating on nothing is not.
    expect(LM.fallsBackToProjected('canvas')).toBe(false);
    expect(LV.surfaceSpec('job-site-map')).toBeNull();
  });

  test('a room refusal is a PAUSE; a content refusal DEGRADES to the projection', () => {
    // The composition that pays for the mirror being narrow: nobody ever gets
    // less than phase 02 already gave them.
    for (const r of ['ledger', 'no_root', 'not_mirrorable']) expect(LM.fallsBackToProjected(r)).toBe(true);
    for (const r of ['off_room', 'away', 'not_shared', 'canvas']) expect(LM.fallsBackToProjected(r)).toBe(false);
  });

  test('EVERY refusal has words on BOTH surfaces — no silent named state', () => {
    // A refusal with a name and no sentence is the honesty rule reduced to a
    // log line. `too_big` was exactly that until this assertion: the server
    // REFUSES an oversized frame rather than truncating it (a truncated DOM is
    // a wrong screen that looks like a right one), and the host and the guest
    // both have to be able to read why.
    const reasons = ['off_room', 'not_shared', 'away', 'ledger', 'no_root', 'canvas', 'not_mirrorable', 'too_big'];
    const GUEST = read('live.html');
    for (const r of reasons) {
      expect(LM.hostRefusalText(r).length).toBeGreaterThan(10);
      // And the guest's third-person twin, for every refusal that leaves them
      // looking at something rather than at a pause.
      if (LM.fallsBackToProjected(r) || r === 'canvas') expect(GUEST).toContain(r + ':');
    }
  });

  test('a refusal the room does not know about still stops the "waiting" claim', () => {
    // mirrorableHere() is computed from the room's list, so a screen the ROOM
    // shares and the MIRROR declines — too_big is the live case — would leave
    // the bar saying "waiting for John's screen" forever.
    const GUEST = read('live.html');
    expect(GUEST).toMatch(/mirrorRefusal = \(data && data\.reason\) \|\| null;/);
    expect(GUEST).toMatch(/mirroring && mirrorRefusal\) arrangement/);
  });
});

// ══ 4. THE ENTITY ID DOES NOT CROSS ════════════════════════════════════════

describe('an attribute allow-list filters NAMES; this also filters VALUES', () => {
  test('the room\'s own entity id is stripped out of an id attribute', () => {
    // js/schedule.js:3686 — id="schJobWxBody-<jobId>" — puts the withheld
    // entity_id in an element id on a job pane.
    const jobId = 'a3f1c2d4-55aa-4b7c-9e11-0123456789ab';
    const out = MC.scrubIdValue('schJobWxBody-' + jobId);
    expect(out).not.toContain(jobId);
    // The SHAPE survives, because CSS selects on ids and dropping the attribute
    // would change the layout.
    expect(out).toMatch(/^schJobWxBody-/);
  });

  test('the CO row\'s record key is stripped, in every id shape this app mints', () => {
    const shapes = [
      'a3f1c2d4-55aa-4b7c-9e11-0123456789ab',      // uuid
      'lrm_m1x9k2p_9a8b7c6d',                       // genId()
      'deadbeefdeadbeefdeadbeef',                   // long hex
      '1234567890123'                               // long digit run
    ];
    for (const s of shapes) {
      expect(MC.looksLikeId(s)).toBe(true);
      expect(MC.scrubIdValue('row-' + s)).not.toContain(s);
    }
  });

  test('an ordinary id is left alone, so the app\'s own CSS still applies', () => {
    for (const ok of ['wip-contract-income', 'job-overview-change-orders', 'co-table', 'wsRightContent']) {
      expect(MC.looksLikeId(ok)).toBe(false);
      expect(MC.scrubIdValue(ok)).toBe(ok);
    }
  });

  test('data-* is denied wholesale except a frozen presentational list', () => {
    // The two that carry record keys today.
    expect(MC.isAllowedAttr('data-co-open')).toBe(false);
    expect(MC.isAllowedAttr('data-co-new')).toBe(false);
    expect(MC.isAllowedAttr('data-bill-id')).toBe(false);
    expect(MC.isAllowedAttr('data-task-id')).toBe(false);
    // And the ones the app's own sheets select on.
    expect(MC.isAllowedAttr('data-p86-icon')).toBe(true);
    expect(MC.isAllowedAttr('data-panel')).toBe(true);
    // The allow-list is not a wildcard.
    for (const d of MC.DATA_ALLOW) expect(d.indexOf('data-')).toBe(0);
  });

  test('NO event handler attribute crosses, at any length', () => {
    for (const h of ['onclick', 'oninput', 'onerror', 'onload', 'onmouseover', 'onfocus', 'on']) {
      expect(MC.isAllowedAttr(h)).toBe(false);
    }
    // And the mechanism, not just the sample: nothing beginning with "on".
    expect(MC.ATTR_ALLOW.filter((a) => a.indexOf('on') === 0)).toEqual([]);
  });

  test('the CO pane\'s real markup would have leaked, and does not', () => {
    // Taken verbatim from js/jobs.js:826 rather than invented.
    expect(read('js', 'jobs.js')).toContain('data-co-open="');
    expect(MC.isAllowedAttr('data-co-open')).toBe(false);
  });
});

// ══ 5. THE UNMIRRORABLE IS LABELLED, NEVER BLANK ═══════════════════════════

describe('anything that cannot be mirrored says so', () => {
  test('canvas, iframe and embeds become a labelled box, not a hole', () => {
    for (const t of ['canvas', 'iframe', 'object', 'embed', 'video', 'audio']) {
      const v = MC.tagVerdict(t);
      expect(v.drop).toBeUndefined();
      expect(typeof v.substitute).toBe('string');
      expect(v.substitute.length).toBeGreaterThan(3);
    }
  });

  test('a script never crosses in any form', () => {
    expect(MC.tagVerdict('script').drop).toBe(true);
    expect(MC.tagVerdict('SCRIPT').drop).toBe(true);
    // And the stage cannot run one even if serialization ever missed it.
    expect(code('js', 'live-mirror-guest.js')).toMatch(/setAttribute\('sandbox', 'allow-same-origin'\)/);
    expect(code('js', 'live-mirror-guest.js')).not.toMatch(/allow-scripts|allow-forms|allow-popups|allow-top-navigation|allow-modals/);
  });

  test('THE STATIC MAPS KEY NEVER CROSSES, from any host', () => {
    // /api/config/maps-key is requireAuth, so a forwarded-link holder — who is
    // authenticated to nothing — never legitimately holds it. This is the case
    // "they have access to the job anyway" does not cover.
    expect(MC.urlVerdict('https://maps.googleapis.com/maps/api/staticmap?center=x&key=AIzaSECRET', 'https://p86.test'))
      .toBe('API key');
    expect(MC.urlVerdict('/whatever?key=AIzaSECRET', 'https://p86.test')).toBe('API key');
    expect(MC.urlVerdict('https://www.google.com/maps?q=1&output=embed', 'https://p86.test')).toBe('map');
  });

  test('an authenticated attachment is labelled, not shipped to a 401', () => {
    const v = MC.urlVerdict('/api/attachments/raw/abc', 'https://p86.test');
    expect(v).toBe('sign-in required');
    expect(window_reasonText(v)).toMatch(/sign-in/i);
  });

  test('a blob: URL is labelled — it is document-scoped and dead in a guest tab', () => {
    expect(MC.urlVerdict('blob:https://p86.test/1234', 'https://p86.test')).toBe('local file');
  });

  test('the public attachment host is allowed, as a STATED decision', () => {
    // Already an unauthenticated bearer URL (server/storage.js R2_PUBLIC_BASE),
    // so mirroring it discloses nothing the URL did not. The consequence — it
    // outlives the room — is told to the host in words.
    expect(MC.urlVerdict('https://attachments.project86.net/x/y.jpg', 'https://p86.test')).toBeNull();
    expect(read('js', 'live-rooms.js')).toMatch(/keeps it after this session ends/);
  });

  test('a same-origin app asset still loads', () => {
    expect(MC.urlVerdict('/icons/x.svg', 'https://p86.test')).toBeNull();
    expect(MC.urlVerdict('#gradient-1', 'https://p86.test')).toBeNull();
  });

  test('every substitution reason has guest-facing words', () => {
    const GUEST = read('js', 'live-mirror-guest.js');
    for (const key of Object.keys(MC.SUBSTITUTE)) {
      expect(GUEST).toContain("'" + MC.SUBSTITUTE[key] + "'");
    }
    for (const r of ['API key', 'sign-in required', 'local file', 'map', 'external']) {
      expect(GUEST).toContain("'" + r + "'");
    }
  });

  // The guest file is a browser IIFE; lift its reason table rather than
  // standing up a DOM for one lookup.
  function window_reasonText(r) {
    const SRC = read('js', 'live-mirror-guest.js');
    const start = SRC.indexOf('var REASON_TEXT = {');
    const end = SRC.indexOf('};', start) + 2;
    // eslint-disable-next-line no-new-func
    const table = new Function(SRC.slice(start, end) + ' return REASON_TEXT;')();
    return Object.prototype.hasOwnProperty.call(table, r) ? table[r] : 'Not shared';
  }
});

// ══ 6. MODE IS EXPLICIT, FAIL-CLOSED, AND CANNOT LIE ═══════════════════════

describe('mode narrows on anything it does not recognise', () => {
  test('only the literal string turns the mirror on', () => {
    expect(LM.normalizeMode('mirror')).toBe('mirror');
    for (const v of ['projected', 'MIRROR', 'Mirror', '', null, undefined, 0, 1, true, {}, 'draw', 'mirror ']) {
      expect(LM.normalizeMode(v)).toBe('projected');
    }
  });

  test('the row projection normalises the same way', () => {
    // A row written by a future build and read by an older one must NARROW.
    expect(L.publicRoom({ mode: 'mirror' }, 't', Date.now()).mode).toBe('mirror');
    expect(L.publicRoom({ mode: 'holograph' }, 't', Date.now()).mode).toBe('projected');
    expect(L.publicRoom({}, 't', Date.now()).mode).toBe('projected');
  });

  test('THE ROW CANNOT CLAIM A REDACTION THE TRANSPORT IS NOT DOING', () => {
    // The invariant, at the write. A mirrored room streams the host's raw pane;
    // hide_financials=true beside it would be the bad outcome this feature is
    // named after.
    expect(LM.modeWrite('mirror', true)).toEqual({ mode: 'mirror', hide_financials: false });
    expect(LM.modeWrite('mirror', false)).toEqual({ mode: 'mirror', hide_financials: false });
    // And the other direction restores the narrow default.
    expect(LM.modeWrite('projected', true)).toEqual({ mode: 'projected', hide_financials: true });
    expect(LM.modeWrite('projected', undefined)).toEqual({ mode: 'projected', hide_financials: true });
    expect(LM.modeWrite('anything', true)).toEqual({ mode: 'projected', hide_financials: true });
  });

  test('and the policy door defends it from the other side', () => {
    const R = read('server', 'routes', 'live-routes.js');
    const start = R.indexOf("router.post('/rooms/:id/policy'");
    const fn = R.slice(start, R.indexOf("router.post('/rooms/:id/mode'", start));
    expect(fn).toMatch(/LM\.normalizeMode\(room\.mode\) === 'mirror'/);
    expect(fn).toMatch(/MIRROR_MODE/);
  });

  test('THE SEAM AGREES WITH THE ROW RATHER THAN TRUSTING IT', () => {
    // projectEvent's last line is `return event`, so an unknown type passed
    // straight through to every recipient regardless of policy. A DB invariant
    // is not a classification, and this file is the repo's single
    // classification point.
    const guest = { role: 'viewer', policy: { money: false } };
    const rich = { role: 'viewer', policy: { money: true } };
    for (const t of ['mirror-snap', 'mirror-op', 'mirror-off']) {
      expect(LV.projectEvent({ type: t, snapSeq: 3 }, guest)).toBeNull();
      expect(LV.projectEvent({ type: t, snapSeq: 3 }, rich)).toBeTruthy();
    }
  });

  test('and the mirror POINTER on hello is dropped for the same recipient', () => {
    const guest = { role: 'viewer', policy: { money: false } };
    const out = LV.projectEvent({ type: 'hello', room: { title: 'x' }, mirror: { snapSeq: 2, surface: 'job-wip-report' } }, guest);
    expect(out.mirror).toBeNull();
    const rich = { role: 'viewer', policy: { money: true } };
    expect(LV.projectEvent({ type: 'hello', room: { title: 'x' }, mirror: { snapSeq: 2 } }, rich).mirror).toEqual({ snapSeq: 2 });
  });
});

// ══ 7. RESUME GIVES THE CURRENT SCREEN, NOT A REPLAY ═══════════════════════

describe('a joining guest is given the screen, never a motion trail', () => {
  test('with no frame on the hub, the guest WAITS and is told so', () => {
    const d = LM.mirrorResume({ hasSnapshot: false, guestSnapSeq: 0, snapSeq: 0 });
    expect(d.action).toBe('wait');
    expect(d.reason).toBe('no_snapshot');
  });

  test('a fresh guest pulls the whole frame', () => {
    const d = LM.mirrorResume({ hasSnapshot: true, guestSnapSeq: 0, snapSeq: 7, surface: 'job-wip-report' });
    expect(d.action).toBe('pull');
    expect(d.reason).toBe('first_frame');
  });

  test('a guest holding an OLD frame pulls rather than patching onto it', () => {
    const d = LM.mirrorResume({ hasSnapshot: true, guestSnapSeq: 5, snapSeq: 7 });
    expect(d.action).toBe('pull');
    expect(d.reason).toBe('behind');
  });

  test('a guest on the current frame replays the tail', () => {
    const d = LM.mirrorResume({ hasSnapshot: true, guestSnapSeq: 7, snapSeq: 7, stale: false });
    expect(d.action).toBe('replay');
    expect(d.reason).toBe('mirror_resumed');
  });

  test('an OVERFLOWED tail pulls, and says which — "nothing to send" and "cannot cover you" must not look alike', () => {
    const d = LM.mirrorResume({ hasSnapshot: true, guestSnapSeq: 7, snapSeq: 7, stale: true });
    expect(d.action).toBe('pull');
    expect(d.reason).toBe('mirror_stale');
  });

  test('a frame for a surface the host has left is never patched across', () => {
    const d = LM.mirrorResume({
      hasSnapshot: true, guestSnapSeq: 7, snapSeq: 7,
      guestSurface: 'job-wip-report', surface: 'job-changeorders'
    });
    expect(d.action).toBe('pull');
    expect(d.reason).toBe('surface_moved');
  });

  test('the tail is bounded by BYTES and by AGE, never by a count', () => {
    const now = 1000000;
    // Age: an op older than the window can never be replayed, and dropping it
    // means the tail no longer starts at the snapshot — which is what `stale`
    // records rather than leaves to be inferred from an empty array.
    const aged = LM.foldOps([{ t: now - LM.MIRROR_OPS_MAX_AGE_MS - 1, op: { o: 'r', i: 1 } }], [{ o: 'r', i: 2 }], 40, now);
    expect(aged.stale).toBe(true);
    expect(aged.ops.length).toBe(1);

    // Bytes: one fat batch evicts, and says so.
    const fat = [{ o: 'a', p: 1, b: null, n: { i: 2, t: 'div', a: {}, c: [], pad: 'x'.repeat(LM.MIRROR_MAX_OPS_BYTES) } }];
    const over = LM.foldOps([], fat, 0, now);
    expect(over.stale).toBe(true);

    // A quiet room stays coverable.
    const fine = LM.foldOps([], [{ o: 't', i: 3, x: 'hello' }], 0, now);
    expect(fine.stale).toBe(false);
    expect(fine.ops.length).toBe(1);
  });

  test('MUTATIONS NEVER TAKE A RING SLOT', () => {
    // The ring is RING_MAX control events and resume depends on it. Feeding
    // mutations in would evict view / presence / policy / mode — the same
    // argument that kept cursor frames out.
    const R = read('server', 'routes', 'live-routes.js');
    const start = R.indexOf("emit(ctx.room.id, 'mirror-op'");
    expect(start).toBeGreaterThan(-1);
    expect(R.slice(start, start + 220)).toMatch(/\{ cursor: true/);
    const snap = R.indexOf("emit(ctx.room.id, 'mirror-snap'");
    expect(R.slice(snap, snap + 320)).toMatch(/\{ cursor: true \}/);
  });

  test('a takeover asks the host to re-send instead of orphaning every guest', () => {
    // live-routes' takeover path only bumps takeover_count, and h.mirror is
    // per-process, so without this every deploy leaves a room mirroring into
    // nothing.
    const R = read('server', 'routes', 'live-routes.js');
    expect(R).toMatch(/resnapshot: true/);
    expect(read('js', 'live-mirror-host.js')).toMatch(/if \(j\.resnapshot\)/);
  });
});

// ══ 8. THE GUEST CANNOT WRITE OR REACH PAST ITS ROOM ═══════════════════════

describe('the mirror opens no door a guest can push on', () => {
  const R = read('server', 'routes', 'live-routes.js');

  test('the mirror up-channel is host-only, refused at execution', () => {
    const start = R.indexOf("router.post('/:roomId/mirror/:streamKey'");
    const fn = R.slice(start, R.indexOf('// GET /api/live/:roomId/mirror', start));
    expect(fn).toMatch(/ctx\.role !== 'host'/);
    // Before anything is read out of the body.
    expect(fn.indexOf("ctx.role !== 'host'")).toBeLessThan(fn.indexOf('req.body'));
  });

  test('the snapshot pull has NO parameter that could name a record', () => {
    // The property that makes "a guest cannot reach any record but the
    // presented one" a fact about the route SHAPE rather than about a check.
    const line = R.slice(R.indexOf("router.get('/:roomId/mirror/:streamKey/snapshot'"));
    const sig = line.slice(0, line.indexOf('\n'));
    expect(sig).not.toMatch(/:entity|:job|:id\b/);
    expect(sig).toMatch(/:roomId\/mirror\/:streamKey\/snapshot/);
  });

  test('the limiter param is spelled :streamKey EXACTLY', () => {
    // keyGenerator reads req.params.streamKey and silently falls back to 'ip:'
    // otherwise — name it anything else and every guest behind one NAT shares a
    // bucket.
    const RL = read('server', 'rate-limit.js');
    for (const name of ['liveMirrorLimiter', 'liveSnapLimiter']) {
      const at = RL.indexOf('const ' + name);
      expect(at).toBeGreaterThan(-1);
      expect(RL.slice(at, at + 700)).toMatch(/req\.params && req\.params\.streamKey/);
    }
  });

  test('the pull does NOT inherit the read proxy\'s 30/min bucket', () => {
    // Two correct-in-isolation rules make a livelock otherwise: the answer to
    // "you fell behind" is itself a pull.
    const RL = read('server', 'rate-limit.js');
    const at = RL.indexOf('const liveSnapLimiter');
    const cfg = RL.slice(at, at + 400);
    const max = /max:\s*(\d+)/.exec(cfg);
    expect(Number(max[1])).toBeGreaterThan(30);
    expect(RL).toMatch(/liveRoomSnapLimiter/);
  });

  test('mode, snapshot and mirror doors all clear the cached frame', () => {
    expect(R).toMatch(/function clearMirror/);
    // Teardown, the mode change, and every unauthorized flush.
    const destroy = R.slice(R.indexOf('function destroyHub'), R.indexOf('// ── The projection seam'));
    expect(destroy).toMatch(/clearMirror\(h\)/);
    const mode = R.slice(R.indexOf("router.post('/rooms/:id/mode'"), R.indexOf("router.post('/rooms/:id/kick'"));
    expect(mode).toMatch(/clearMirror\(h\)/);
  });

  test('and the pull checks MODE, which loadStreamContext cannot', () => {
    // loadStreamContext re-queries per request and covers kick, revoke and
    // expiry — but not mode, and a cached snapshot is frozen under the policy
    // that captured it.
    const g = R.slice(R.indexOf("router.get('/:roomId/mirror/:streamKey/snapshot'"));
    expect(g).toMatch(/LM\.normalizeMode\(ctx\.room\.mode\) !== 'mirror'/);
    expect(g).toMatch(/NOT_MIRRORING/);
    expect(g.indexOf('loadStreamContext')).toBeLessThan(g.indexOf('normalizeMode'));
  });

  test('a frame captured for a surface the room has left is not served', () => {
    const g = R.slice(R.indexOf("router.get('/:roomId/mirror/:streamKey/snapshot'"));
    expect(g).toMatch(/SURFACE_MOVED/);
  });

  test('backpressure is no longer invisible', () => {
    // writeFrame discarded res.write's return value, so MAX_CONSEC_WRITE_FAILS
    // could only fire on a throw and a guest whose socket buffer was full
    // accumulated a silently desyncing DOM.
    const wf = R.slice(R.indexOf('function writeFrame'), R.indexOf('// Fan out to every open stream'));
    expect(wf).toMatch(/const ok = sub\.res\.write/);
    expect(wf).toMatch(/sub\.soft = \(sub\.soft \|\| 0\) \+ 1/);
    expect(R).toMatch(/MAX_CONSEC_SOFT_FAILS/);
  });
});
