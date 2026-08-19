/**
 * @jest-environment jsdom
 */
// Live Rooms phase 02 — the guest shell, and the honesty rules it has to obey.
//
// What is proven here: the renderer has no numeric fallback (a hidden figure
// cannot become "$0.00"), the mirror's four states are distinguishable and a
// broken one stops CLAIMING rather than blanking, the guest page does not boot
// the host surface, and the presenter's own app gains nothing but an overlay.
//
// What is NOT proven here, said plainly rather than implied: two real browsers
// in the same room. Nothing below opens an EventSource, so the actual latency
// of "he clicks, my screen follows", the PWA confirm overlay, and the phone
// layout are checked by hand. The list is in the report.

const fs = require('fs');
const path = require('path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

// Every "this pattern must NOT appear" assertion below runs against CODE, not
// prose. These files explain what they refuse to do — `format(val || 0)`,
// localStorage, "no blur language anywhere" — and a naive grep would fail on
// the explanation rather than on the defect, which teaches the next person to
// delete the comment instead of the bug.
const stripJs = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const stripHtml = (s) => stripJs(s.replace(/<!--[\s\S]*?-->/g, ''));
const code = (...p) => stripJs(read(...p));

const V = require('../js/live-view.js');

// ══ The typed renderer ═════════════════════════════════════════════════════

describe('a money slot has two shapes and the renderer has two branches', () => {
  test('a redacted cell is a dash — it can never become $0.00', () => {
    expect(V.cellText({ r: true })).toBe('—');
    expect(V.cellText({ r: true }, '%')).toBe('—');
    // js/app.js formatCurrency is format(val || 0), so a DELETED money field
    // prints "$0.00": a job sold at zero, rendered confidently in the same
    // style as a real figure. None of these reach a dollar sign.
    expect(V.cellText(undefined)).toBe('—');
    expect(V.cellText(null)).toBe('—');
    expect(V.cellText({})).toBe('—');
    expect(V.cellText({ m: null })).toBe('—');
    expect(V.cellText({ m: 'lots' })).toBe('—');
    expect(V.cellText({ m: NaN })).toBe('—');
    expect(V.cellText({ m: Infinity })).toBe('—');
  });

  test('a REAL zero still prints as zero — the two are different facts', () => {
    // "I do not have this" and "this is zero" are materially different, which
    // is the whole reason js/jobs.js:3410 prints "—" rather than "0.0%".
    expect(V.cellText({ m: 0 })).toBe('$0.00');
    expect(V.cellText({ m: 0 }, '%')).toBe('0.0%');
    expect(V.cellText({ m: 1234.5 })).toBe('$1,234.50');
    expect(V.cellText({ m: 22.47 }, '%')).toBe('22.5%');
  });

  test('there is no numeric fallback anywhere in the renderer', () => {
    const SRC = code('js', 'live-view.js');
    // The single pattern that turns a missing figure into a confident zero,
    // asserted on the MONEY PATH rather than on the whole file — mirrorState
    // counts reconnect attempts and `attempts || 0` there is a counter, not a
    // price. A blanket grep would push someone to contort a loop counter to
    // satisfy a test, which is how a rule stops meaning anything.
    const money = SRC.slice(SRC.indexOf('function cellText'), SRC.indexOf('function reasonText'));
    // `||` as a GUARD is fine (`if (!cell || typeof cell !== 'object')`).
    // `||` as a VALUE — a number or a string on its right — is the defect.
    expect(money).not.toMatch(/\|\|\s*['"\d]/);
    expect(SRC).not.toMatch(/\.m\s*\|\|/);
    expect(SRC).not.toMatch(/cell[^\n]*\|\|\s*0/);
    // And the only two branches that can produce a number are the ones checked
    // above: everything else returns the dash.
    expect((money.match(/return '—';/g) || []).length).toBeGreaterThanOrEqual(3);
  });
});

describe('the rendered surfaces', () => {
  function render(doc) {
    const el = document.createElement('div');
    window.p86LiveView.render(el, doc);
    return el;
  }

  test('every redacted WIP row paints a dash, and no dollar sign appears', () => {
    const doc = {
      surface: 'job-wip-report', title: 'RV2006 Waterside', pctComplete: 51.3,
      sections: [{ heading: 'Contract', rows: [
        { label: 'Contract income', cell: { r: true }, unit: null },
        { label: 'As-sold margin', cell: { r: true }, unit: '%' }
      ] }]
    };
    const el = render(doc);
    expect(el.querySelectorAll('.lv-money.is-redacted').length).toBe(2);
    expect(el.textContent).not.toContain('$');
    expect(el.textContent).toContain('51.3%');   // progress survives
  });

  test('wide content scrolls inside itself, never the page', () => {
    // A guest shell whose BODY scrolls sideways on a phone is unusable in a
    // truck, which is the stated case for this whole feature.
    const el = render({
      surface: 'job-changeorders', title: 'x', count: 1,
      rows: [{ number: 'CO-1', status: 'approved', description: 'Add 3 doors', approved: '2026-04-09', income: { r: true }, costs: { r: true } }]
    });
    const table = el.querySelector('table');
    expect(table.closest('.lv-scroll')).toBeTruthy();
    expect(read('css', 'live-view.css')).toMatch(/\.lv-scroll\s*\{[^}]*overflow-x:\s*auto/);
  });

  test('a surface this build cannot draw says so, rather than painting an empty job', () => {
    const el = render({ surface: 'job-payapps', title: 'x' });
    expect(el.textContent).toMatch(/not available in the viewer/i);
    const el2 = render(null);
    expect(el2.textContent).toMatch(/not available in the viewer/i);
  });

  test('untrusted text is escaped — a display name is rendered beside a room', () => {
    const el = render({
      surface: 'job-changeorders', title: '<img src=x onerror=alert(1)>', count: 1,
      rows: [{ number: '<b>x</b>', status: 'draft', description: '<script>bad()</script>', approved: null, income: { r: true }, costs: { r: true } }]
    });
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('script')).toBeNull();
    expect(el.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});

// ══ The mirror's honesty ═══════════════════════════════════════════════════

describe('a stale or broken mirror says so', () => {
  const base = { hostName: 'John', hostSurface: 'job-wip-report', mySurface: 'job-wip-report', following: true };

  test('fresh and following: it claims, and claims WHO', () => {
    const m = V.mirrorState(Object.assign({}, base, { msSinceFrame: 500 }));
    expect(m.kind).toBe('following');
    expect(m.claim).toBe('Following John');
    expect(m.stamp).toBe(false);
  });

  test('35s of silence: it CAVEATS rather than claiming', () => {
    const m = V.mirrorState(Object.assign({}, base, { msSinceFrame: 40000 }));
    expect(m.kind).toBe('unconfirmed');
    expect(m.note).toMatch(/may not be what John is looking at/);
    expect(m.stamp).toBe(true);
  });

  test('60s or three failed attempts: it STOPS claiming, and does not blank', () => {
    for (const s of [{ msSinceFrame: 61000 }, { attempts: 3, msSinceFrame: 100 }]) {
      const m = V.mirrorState(Object.assign({}, base, s));
      expect(m.kind).toBe('broken');
      expect(m.note).toMatch(/can't tell what John is looking at/);
      // The CLAIM is withdrawn; the document is not. Those numbers were real
      // when they were fetched, and blanking them is its own lie — so the
      // surface gets stamped with when it was true instead.
      expect(m.stamp).toBe(true);
      expect(m.claim).not.toMatch(/^Following/);
    }
  });

  test('multi-instance is a PERMANENT broken state, and the guest is told', () => {
    // On cursors, a wrong replica is a MISSING cursor. On a mirror, it is a
    // guest confidently watching the wrong page while the bar says Live. The
    // host's strip already warns; this is the warning that matters, because the
    // guest is the one being misled.
    const m = V.mirrorState(Object.assign({}, base, { msSinceFrame: 100, multiInstance: true }));
    expect(m.kind).toBe('broken');
    expect(m.note).toMatch(/keeps moving between servers/);
    expect(m.claim).not.toMatch(/^Following/);
  });

  test('the three not-shared reasons are distinguishable, and name no record', () => {
    const off = V.mirrorState({ hostName: 'John', msSinceFrame: 100, hostSurface: null, hostReason: 'off_room' });
    const ns = V.mirrorState({ hostName: 'John', msSinceFrame: 100, hostSurface: null, hostReason: 'not_shared' });
    const away = V.mirrorState({ hostName: 'John', msSinceFrame: 100, hostSurface: null, hostReason: 'away' });
    expect(off.note).toMatch(/different record/);
    expect(ns.note).toMatch(/isn't shared/);
    expect(away.note).toMatch(/stepped away/);
    for (const m of [off, ns, away]) {
      expect(m.kind).toBe('not_shared');
      expect(m.note).not.toMatch(/job_/);
    }
  });

  test('Back to <host> appears only when we are elsewhere, and says WHERE it goes', () => {
    const same = V.mirrorState(Object.assign({}, base, { msSinceFrame: 100 }));
    expect(same.showBack).toBe(false);
    const away = V.mirrorState(Object.assign({}, base, {
      msSinceFrame: 100, mySurface: 'job-changeorders', following: false, hostSurfaceLabel: 'WIP Report'
    }));
    expect(away.kind).toBe('unfollowed');
    expect(away.showBack).toBe(true);
    // An informed choice, not a mystery button.
    expect(away.backLabel).toBe('Back to John — WIP Report');
  });

  test('expiry is a clock time AND a countdown', () => {
    const t = new Date(Date.now() + 3 * 3600e3 + 25 * 60e3).toISOString();
    const s = V.expiryText(t);
    expect(s).toMatch(/Link stops working at .+ \(in 3h 2[45]m\)/);
    // Past its own deadline it stops counting down and says the plain thing.
    expect(V.expiryText(new Date(Date.now() - 1000).toISOString())).toBe('The link has stopped working.');
    expect(V.expiryText('not a date')).toBe('');
  });
});

// ══ The guest page ═════════════════════════════════════════════════════════

describe('the guest shell is not the app', () => {
  const HTML = read('live.html');
  const BODY = stripHtml(HTML);

  test('it loads exactly two of the app JS files, and none of the SPA', () => {
    const srcs = Array.from(HTML.matchAll(/<script src="([^"]+)"/g)).map((m) => m[1]);
    expect(srcs.map((s) => s.split('?')[0]).sort()).toEqual(['/js/live-rooms.js', '/js/live-view.js']);
    // js/app.js loadData() opens with eight ORG-WIDE GETs in one Promise.all —
    // every job, estimate, QB cost line, sub, PO, CO, bill and AR invoice. A
    // guest shell that booted the SPA would download the company.
    for (const bad of ['js/app.js', 'js/api.js', 'js/jobs.js', 'js/auth.js', 'nodegraph/', 'js/pricing-pipeline.js']) {
      expect(BODY).not.toContain(bad);
    }
  });

  test('the guest page does not boot the HOST surface', () => {
    // Phase 01's boot() ran unconditionally on this page: it appended a host
    // strip, bound a document-level pointermove, and fired GET /api/live/mine
    // WITH CREDENTIALS — delivering a signed-in visitor's own room tokens to
    // the guest page and then joining that room as host from the guest tab,
    // which supersedes and kills the presenting tab. Opening the link you just
    // copied is the first thing anyone does.
    const JS = read('js', 'live-rooms.js');
    expect(JS).toMatch(/function isGuestPage/);
    const boot = JS.slice(JS.indexOf('function boot()'));
    const gate = boot.indexOf('if (isGuestPage()) return;');
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(boot.indexOf('adoptExistingRooms()'));
    expect(gate).toBeLessThan(boot.indexOf('wireCursorSampling()'));
    expect(gate).toBeLessThan(boot.indexOf('stripEl()'));
  });

  test('nothing about the guest survives the session', () => {
    // A credential in localStorage on a guest's phone outlives the meeting.
    expect(BODY).not.toContain('localStorage');
    expect(BODY).not.toContain('sessionStorage');
    expect(BODY).not.toContain('document.cookie');
    expect(BODY).not.toContain('serviceWorker');
    // The view proxy is called with credentials OMITTED: a guest is not a user
    // and must not ride an ambient cookie into a read.
    expect(HTML).toMatch(/credentials:\s*'omit'/);
  });

  test('the guest bar states whose screen this is, that it is read-only, and when it dies', () => {
    expect(HTML).toMatch(/read-only/);
    expect(HTML).toMatch(/expiryText/);
    expect(HTML).toMatch(/"'s screen"|'s screen/);
    // And a terminal state CLEARS the document rather than leaving a rendered
    // job on screen after a revoke.
    const dead = HTML.slice(HTML.indexOf('function showDead'));
    expect(dead.slice(0, 400)).toMatch(/surface'\)\.innerHTML = ''/);
    expect(dead.slice(0, 400)).toMatch(/lastDoc = null/);
  });

  test('a policy flip DISCARDS the document rather than patching it', () => {
    expect(HTML).toMatch(/lastPolicyMoney !== money/);
    const blk = HTML.slice(HTML.indexOf('lastPolicyMoney !== money'));
    expect(blk.slice(0, 300)).toMatch(/lastDoc = null/);
    expect(blk.slice(0, 300)).toMatch(/loadSurface\(mySurface, true\)/);
  });

  test('coming back from another app refetches instead of trusting a stale page', () => {
    expect(HTML).toMatch(/visibilitychange/);
  });

  test('breaking off reaches nothing a following guest could not', () => {
    // The guest's tab strip is built from `session.surfaces`, which the SERVER
    // sends and which is the same frozen allow-list the read proxy enforces.
    // The toggle changes WHEN they fetch, never WHAT they may fetch.
    expect(HTML).toMatch(/session\.surfaces/);
    expect(BODY).not.toMatch(/entity_id/);
  });

  test('the host pointer is not drawn on a document it was never measured against', () => {
    // Phase 01 normalises a cursor to the DOCUMENT it was measured on. The host
    // measures index.html's workspace; this page is a bespoke single column.
    // Drawing a confident arrow at the wrong row is the claim this feature has
    // been corrected against all week, and anchoring to an element is phase
    // 03's mechanism, not a mobile-polish shortcut.
    expect(BODY).not.toMatch(/paintCursors|sampleCursor/);
    expect(HTML).toMatch(/not their pointer/);
  });
});

// ══ The presenter's own app ════════════════════════════════════════════════

describe("the presenter's own app is unchanged outside a room", () => {
  const JS = read('js', 'live-rooms.js');
  const CODE = stripJs(JS);

  test('the strip is still an additive body-fixed overlay, not a mode', () => {
    expect(JS).toMatch(/document\.body\.appendChild\(el\)/);
    expect(read('css', 'live-rooms.css')).toMatch(/\.p86-live-strip\s*\{[^}]*position:\s*fixed/);
    // Nothing in this feature writes app state.
    expect(CODE).not.toMatch(/appData\./);
    expect(CODE).not.toMatch(/localStorage/);
    expect(CODE).not.toMatch(/saveData|writeToLocalStorage/);
  });

  test('phase 02 adds exactly one global, and it is inert on the app page', () => {
    const VIEWJS = read('js', 'live-view.js');
    const globals = Array.from(VIEWJS.matchAll(/^\s*window\.([A-Za-z0-9_$]+)\s*=/gm)).map((m) => m[1]);
    expect(globals).toEqual(['p86LiveView']);
    // index.html loads it for the expiry helper only, so "exactly when the link
    // stops working" is computed by ONE function rather than two copies.
    const INDEX = read('index.html');
    expect(INDEX).toMatch(/js\/live-view\.js\?v=\d+/);
    expect(INDEX).toMatch(/js\/live-rooms\.js\?v=[2-9]\d*/);
    expect(INDEX).toMatch(/css\/live-rooms\.css\?v=[2-9]\d*/);
  });

  test('the Present button mints and copies in one action', () => {
    expect(JS).toMatch(/data-live-act="start">[\s\S]{0,120}Present/);
    const start = JS.slice(JS.indexOf('function startHosting'));
    expect(start.indexOf('attachSession')).toBeLessThan(start.indexOf('copyLink()'));
  });

  test('the kick guard survives the installed PWA', () => {
    // Native confirm() returns undefined inside the PWA, so every
    // `if (!confirm(x)) return` guard silently did nothing there — the dialog
    // never appeared and the action never ran. Kick was broken on the one
    // device this feature is mostly used from.
    const kick = JS.slice(JS.indexOf('function kickParticipant'), JS.indexOf('function setHideFinancials'));
    expect(kick).not.toMatch(/window\.confirm\(/);
    expect(kick).toMatch(/ask\(/);
    expect(JS).toMatch(/typeof window\.p86Confirm === 'function'/);
  });

  test('the panel keeps the kick/revoke distinction truthful, and says it standing', () => {
    // The API's own sentence is rendered verbatim; the surface never composes a
    // softer one. And the limitation is stated PERMANENTLY, not only inside a
    // dialog someone dismisses on reflex.
    expect(JS).toMatch(/if \(j && j\.note\) toast\(j\.note\)/);
    expect(JS).toMatch(/Removing someone ends their session\./);
    expect(JS).toMatch(/revoking is the removal that holds/);
    expect(JS).toMatch(/Remove &amp; revoke link/);
  });

  test('the toggle follows the SERVER, never the click', () => {
    const fn = JS.slice(JS.indexOf('function setHideFinancials'));
    expect(fn).toMatch(/host\.hideFinancials = !!res\.body\.hide_financials/);
    // Nothing is hidden or revealed until the ROW changes, so an optimistic
    // flip would be claiming a redaction that had not happened.
    expect(fn.slice(0, fn.indexOf('paintStrip'))).not.toMatch(/host\.hideFinancials = !!hide/);
    // And the label states the mechanism rather than reassuring about it.
    expect(JS).toMatch(/The server does not send margins, cost or contract values to viewers\./);
    expect(CODE).not.toMatch(/blur/i);
  });

  test('a coarse pointer stops SENDING a cursor but keeps receiving one', () => {
    const w = JS.slice(JS.indexOf('function wireCursorSampling'));
    expect(w).toMatch(/pointer: coarse/);
    const gate = w.indexOf("matchMedia('(pointer: coarse)')");
    expect(gate).toBeLessThan(w.indexOf("addEventListener('pointermove'"));
    // The receiving half — CursorLayer.render — is untouched by the gate.
    expect(JS).toMatch(/CursorLayer\.prototype\.render/);
  });

  test('the route is read on a timer as well as on a click', () => {
    // history.pushState fires no event and js/router.js wraps a FIXED list of
    // nav functions, so an unwrapped navigation path would silently freeze the
    // mirror with no error anywhere. The tick is the backstop that matters.
    const boot = JS.slice(JS.indexOf('function boot()'));
    expect(boot).toMatch(/pushRoute\(\)/);
    expect(boot).toMatch(/setInterval\(/);
    expect(boot).toMatch(/addEventListener\('click'/);
    // And it does not couple this file to js/router.js, which other work edits.
    expect(CODE).not.toMatch(/p86Router/);
  });
});
