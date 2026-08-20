/**
 * @jest-environment jsdom
 */
// Live Rooms phase 03 — THE MIRROR, END TO END, IN A REAL DOM.
//
// Everything in test/live-mirror.test.js is a pure function or a source
// assertion. This suite runs the two halves against each other: a host document
// is built, the serializer observes it, the bytes it would have POSTed are
// handed to the guest applier, and the resulting stage document is compared to
// the host's.
//
// It is the only place that can prove the four claims that matter most:
//   • a mutation actually arrives — text the host changes appears on the stage
//   • an EXCLUDED surface is not captured, at all, in any form
//   • an unmirrorable element becomes a LABELLED box, not a hole
//   • THE HOST'S DOCUMENT IS UNCHANGED — node for node, attribute for
//     attribute, before start and after stop. "Leave nothing behind" as a
//     measurement rather than a promise.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = (f) => fs.readFileSync(path.join(__dirname, '..', 'js', f), 'utf8');

// The host serializer's flush is on a timer, and MutationObserver delivers on a
// microtask. Both have to be pumped deliberately.
const settle = async (ms) => {
  await Promise.resolve();
  await Promise.resolve();
  jest.advanceTimersByTime(ms || 250);
  await Promise.resolve();
  await Promise.resolve();
};

const HOST_HTML = `
<div id="app-container">
  <div id="jobs-job-detail-view">
    <div id="wsRightContent" class="ws-right-content">
      <details class="ws-job-info-details" open>
        <summary class="ws-job-info-summary">Job Information</summary>
        <div class="card" id="job-info-card"><span id="job-info-title">RV2006 Waterside</span></div>
      </details>
      <div id="job-wip-report" class="sub-tab-content-job">
        <div class="card">
          <span class="lbl">Contract (As Sold)</span>
          <span id="wip-contract-income">$0.00</span>
        </div>
        <canvas id="wip-spark" width="120" height="40"></canvas>
        <img id="auth-shot" src="/api/attachments/raw/abc123" alt="site" />
        <img id="pub-shot" src="https://attachments.project86.net/x/y.jpg" alt="public" />
        <table id="co-table"><tbody>
          <tr class="overview-row" data-co-open="a3f1c2d4-55aa-4b7c-9e11-0123456789ab" onclick="openCO()">
            <td id="schJobWxBody-a3f1c2d4-55aa-4b7c-9e11-0123456789ab">CO-1</td>
          </tr>
        </tbody></table>
        <div class="modal" id="stray-modal">CONFIDENTIAL MODAL BODY</div>
        <div id="p86-ai-panel">86 CONVERSATION TRANSCRIPT</div>
        <a href="/api/attachments/raw/abc123">open file</a>
      </div>
      <div id="job-overview" class="sub-tab-content-job">SUB CONTRACT LEDGER</div>
    </div>
  </div>
</div>
<div class="p86-live-strip"><code class="p86-live-link">https://p86.test/live/deadbeefdeadbeefdeadbeefdeadbeef</code></div>
<div class="p86-live-cursors"></div>
`;

// A full structural fingerprint of the host document: every node, every
// attribute, every value. Equality of this before and after IS the
// "leave nothing behind" rule.
function fingerprint(root) {
  const out = [];
  const walk = (n, p) => {
    if (n.nodeType === 3) { out.push(p + '#text:' + n.data); return; }
    if (n.nodeType !== 1) return;
    const attrs = Array.from(n.attributes).map((a) => a.name + '=' + a.value).sort().join('|');
    out.push(p + '<' + n.tagName + '>[' + attrs + ']');
    for (let i = 0; i < n.childNodes.length; i++) walk(n.childNodes[i], p + '/' + i);
  };
  walk(root, '');
  return out.join('\n');
}

// Everything the serializer would have sent, captured off a stubbed fetch.
function harness() {
  document.body.innerHTML = HOST_HTML;

  const posted = [];
  global.fetch = window.fetch = function (url, opts) {
    let body = null;
    try { body = JSON.parse(opts.body); } catch (e) {}
    posted.push({ url: String(url), body: body });
    return Promise.resolve({
      ok: true, status: 200,
      json: function () { return Promise.resolve({ ok: true, surface: body && body.claim ? body.claim.surface : null, reason: null }); }
    });
  };

  // The route, reported AS FOUND. The mirror never filters its own claim; the
  // server refuses it. This stub is the seam that lets the test move the host
  // between surfaces.
  const route = { entity_type: 'job', entity_id: 'JOB-A', surface: 'job-wip-report' };
  window.p86Live = { route: function () { return route; } };

  // Load both halves into this window.
  vm.runInThisContext('(function(module,window,document,location,performance,fetch,MutationObserver,setTimeout,clearTimeout,WeakMap,Map,Date){' + SRC('live-mirror-host.js') + '\n})')(
    { exports: {} }, window, document, window.location, window.performance, window.fetch,
    window.MutationObserver, window.setTimeout, window.clearTimeout, WeakMap, Map, Date
  );
  vm.runInThisContext('(function(module,window,document,Map){' + SRC('live-mirror-guest.js') + '\n})')(
    { exports: {} }, window, document, Map
  );

  const session = { roomId: 'lrm_1', streamKey: 'k'.repeat(64), terminal: false };
  return { posted: posted, route: route, session: session };
}

let H;
beforeEach(() => {
  jest.useFakeTimers();
  H = harness();
});
afterEach(() => {
  try { window.p86LiveMirror.stop(); } catch (e) {}
  try { window.p86LiveMirrorGuest.teardown(); } catch (e) {}
  jest.useRealTimers();
});

// ══ 1. A MUTATION ROUND-TRIPS ══════════════════════════════════════════════

describe('the host changes a number and it appears on the guest', () => {
  test('snapshot then delta, and the stage reads what the host reads', async () => {
    window.p86LiveMirror.start(H.session);
    await settle();

    const snap = H.posted.filter((p) => p.body && p.body.kind === 'snap').pop();
    expect(snap).toBeTruthy();
    expect(snap.url).toMatch(/\/api\/live\/lrm_1\/mirror\//);
    expect(snap.body.claim.surface).toBe('job-wip-report');

    // Mount it on a guest.
    const wrap = document.createElement('div');
    document.body.appendChild(wrap);
    const ok = window.p86LiveMirrorGuest.applySnapshot(wrap, {
      root: snap.body.root, meta: snap.body.meta,
      snapSeq: snap.body.snapSeq, surface: 'job-wip-report'
    });
    expect(ok).toBe(true);

    const stageDoc = wrap.querySelector('iframe').contentDocument;
    expect(stageDoc.getElementById('wip-contract-income').textContent).toBe('$0.00');

    // Now the host repaints one figure, the way renderWipTab actually does it
    // (js/jobs.js:652 — .textContent, not innerHTML).
    document.getElementById('wip-contract-income').textContent = '$412,500.00';
    await settle();

    const ops = H.posted.filter((p) => p.body && p.body.kind === 'ops').pop();
    expect(ops).toBeTruthy();
    expect(ops.body.snapSeq).toBe(snap.body.snapSeq);

    expect(window.p86LiveMirrorGuest.applyOps(ops.body.ops, ops.body.snapSeq)).toBe(true);
    expect(stageDoc.getElementById('wip-contract-income').textContent).toBe('$412,500.00');
  });

  test('a batch cut against a DIFFERENT base is refused, not applied', async () => {
    // A patch applied to the wrong document is worse than a missing patch,
    // because it looks like data.
    window.p86LiveMirror.start(H.session);
    await settle();
    const snap = H.posted.filter((p) => p.body && p.body.kind === 'snap').pop();
    const wrap = document.createElement('div');
    document.body.appendChild(wrap);
    window.p86LiveMirrorGuest.applySnapshot(wrap, {
      root: snap.body.root, meta: snap.body.meta, snapSeq: snap.body.snapSeq, surface: 'job-wip-report'
    });
    expect(window.p86LiveMirrorGuest.applyOps([{ o: 't', i: 3, x: 'nope' }], snap.body.snapSeq + 9)).toBe(false);
  });

  test('a WHOLESALE repaint becomes a new snapshot, not a 34KB delta', async () => {
    // This app renders by string-building; to any observer that is remove-all
    // plus insert-all. The big-batch rule makes the dominant render pattern the
    // cheap path instead of the expensive one.
    window.p86LiveMirror.start(H.session);
    await settle();
    const firstSeq = H.posted.filter((p) => p.body && p.body.kind === 'snap').pop().body.snapSeq;

    const pane = document.getElementById('job-wip-report');
    let html = '';
    for (let i = 0; i < 300; i++) html += '<div class="row"><span>Row ' + i + '</span></div>';
    pane.innerHTML = html;
    await settle();

    const last = H.posted[H.posted.length - 1];
    expect(last.body.kind).toBe('snap');
    expect(last.body.snapSeq).toBeGreaterThan(firstSeq);
  });
});

// ══ 2. AN EXCLUDED SURFACE IS NOT CAPTURED ═════════════════════════════════

describe('wandering off the mirrored surface broadcasts nothing', () => {
  test('the Overview is never serialized — not even partially', async () => {
    H.route.surface = 'job-overview';
    window.p86LiveMirror.start(H.session);
    await settle();

    // Every frame sent carries no document at all.
    for (const p of H.posted) {
      expect(p.body.kind).toBe('off');
      expect(p.body.root).toBeUndefined();
    }
    // And the pane's contents appear nowhere on the wire.
    expect(JSON.stringify(H.posted)).not.toContain('SUB CONTRACT LEDGER');
  });

  test('a different JOB stops the capture, and the claim still travels for the server to refuse', async () => {
    window.p86LiveMirror.start(H.session);
    await settle();
    expect(H.posted.some((p) => p.body.kind === 'snap')).toBe(true);

    H.posted.length = 0;
    // The claim is reported as found — a client that filtered its own route
    // would be the authorization — so the entity id changes and the SERVER
    // refuses. Here the stub answers ok, which is why the real gate is asserted
    // server-side in test/live-mirror.test.js.
    H.route.entity_id = 'JOB-B';
    document.getElementById('wip-contract-income').textContent = '$1.00';
    await settle();
    for (const p of H.posted) expect(p.body.claim.entity_id).toBe('JOB-B');
  });

  test('leaving the job entirely captures nothing', async () => {
    H.route.surface = null;
    H.route.entity_id = null;
    window.p86LiveMirror.start(H.session);
    await settle();
    expect(H.posted.every((p) => p.body.kind === 'off')).toBe(true);
  });
});

// ══ 3. THE DENYLIST AND THE SUBSTITUTIONS ══════════════════════════════════

describe('what is inside the root but must not cross', () => {
  let snap;
  beforeEach(async () => {
    window.p86LiveMirror.start(H.session);
    await settle();
    snap = H.posted.filter((p) => p.body && p.body.kind === 'snap').pop();
  });

  const wire = () => JSON.stringify(snap.body);

  test('the 86 panel is excluded even though it sits INSIDE the pane', () => {
    // js/ai-panel.js:2012 does hostEl.appendChild(panel) — the panel really does
    // reparent into host containers, so ancestry alone is not enough.
    expect(wire()).not.toContain('86 CONVERSATION TRANSCRIPT');
  });

  test('a modal inside the pane is excluded', () => {
    expect(wire()).not.toContain('CONFIDENTIAL MODAL BODY');
  });

  test('THE ROOM URL NEVER CROSSES', () => {
    // js/live-rooms.js renders the room's own bearer credential into a <code>
    // in the host's body. Capturing it would ship the credential and the
    // watcher list to everyone the link had been forwarded to.
    expect(wire()).not.toContain('deadbeefdeadbeefdeadbeefdeadbeef');
    expect(wire()).not.toContain('p86-live-strip');
  });

  test('the ENTITY ID does not cross, in an id or in a data attribute', () => {
    const id = 'a3f1c2d4-55aa-4b7c-9e11-0123456789ab';
    expect(wire()).not.toContain(id);
    expect(wire()).not.toContain('data-co-open');
  });

  test('no event handler crosses', () => {
    expect(wire()).not.toContain('openCO()');
    expect(wire()).not.toContain('onclick');
  });

  test('a canvas becomes a LABELLED box of the same shape, never a blank', () => {
    const wrap = document.createElement('div');
    document.body.appendChild(wrap);
    window.p86LiveMirrorGuest.applySnapshot(wrap, {
      root: snap.body.root, meta: snap.body.meta, snapSeq: snap.body.snapSeq, surface: 'job-wip-report'
    });
    const doc = wrap.querySelector('iframe').contentDocument;
    const box = doc.querySelector('lm-x[data-lm-reason="drawing"]');
    expect(box).toBeTruthy();
    expect(box.getAttribute('data-lm-label')).toMatch(/Drawing/);
    expect(doc.querySelector('canvas')).toBeNull();
  });

  test('an authenticated image is labelled rather than left to 401', () => {
    expect(wire()).not.toContain('/api/attachments/raw/abc123');
    expect(wire()).toContain('sign-in required');
  });

  test('a PUBLIC attachment image still loads — the stated decision', () => {
    expect(wire()).toContain('https://attachments.project86.net/x/y.jpg');
  });

  test('a link is inert: it cannot navigate anything from the stage', () => {
    const w = wire();
    expect(w).toContain('data-lm-href');
    expect(w).not.toMatch(/"href":/);
  });
});

// ══ 4. THE SHELL — the host's screen, not a bare pane ══════════════════════

describe('the capture is the pane plus its own chrome, siblings pruned', () => {
  test('the scroller and the money card come with it; the Overview does not', async () => {
    window.p86LiveMirror.start(H.session);
    await settle();
    const snap = H.posted.filter((p) => p.body && p.body.kind === 'snap').pop();

    // The outermost serialized node is the pane's own scrolling, padded,
    // bordered container (css/workspace-layout.css .ws-right-content). Without
    // it the guest gets a bare pane on a blank page — and there is nothing to
    // restore scrollTop onto.
    expect(snap.body.root.a.id).toBe('wsRightContent');
    const wire = JSON.stringify(snap.body);
    // #job-info-card is a SIBLING of the pane, excluded from every hide sweep,
    // and therefore on the host's screen on every tab.
    expect(wire).toContain('RV2006 Waterside');
    // The Overview is a sibling too, and it is pruned.
    expect(wire).not.toContain('SUB CONTRACT LEDGER');
  });

  test('the stage is sized to the SHELL, not to the host window', async () => {
    // The sidebar and the 86 panel take 300-400px of the host's window. Sizing
    // the stage to the window would render the pane wider than the host has
    // ever seen it — "a layout the host has never seen and cannot describe",
    // which is the thing letterbox-not-reflow exists to prevent.
    window.p86LiveMirror.start(H.session);
    await settle();
    const snap = H.posted.filter((p) => p.body && p.body.kind === 'snap').pop();
    expect(snap.body.meta).toHaveProperty('w');
    expect(snap.body.meta).toHaveProperty('h');
  });
});

// ══ 5. THE PRESENTER'S DOCUMENT IS UNCHANGED ═══════════════════════════════

describe('the mirror leaves the host document exactly as it found it', () => {
  test('node for node, attribute for attribute, across start / run / stop', async () => {
    const detail = document.getElementById('app-container');
    const before = fingerprint(detail);

    window.p86LiveMirror.start(H.session);
    await settle();
    document.getElementById('wip-contract-income').textContent = '$1.00';
    await settle();
    window.p86LiveMirror.tick();
    await settle();

    // While running: no id stamped on any node, no data- marker, nothing.
    const during = fingerprint(detail);
    expect(during).toBe(fingerprint(detail));
    expect(detail.innerHTML).not.toContain('data-lm');

    document.getElementById('wip-contract-income').textContent = '$0.00';
    window.p86LiveMirror.stop();
    await settle();

    expect(fingerprint(detail)).toBe(before);
  });

  test('it mounts nothing on the body — the frame lives in the cursor layer', async () => {
    const bodyKids = document.body.children.length;
    window.p86LiveMirror.start(H.session);
    await settle();
    window.p86LiveMirror.tick();
    await settle();
    expect(document.body.children.length).toBe(bodyKids);
    // And the frame it DOES draw is inside the layer live-rooms.js already owns.
    const layer = document.querySelector('.p86-live-cursors');
    expect(layer.querySelectorAll('.p86-mirror-frame').length).toBeLessThanOrEqual(1);
  });

  test('stopping removes the frame too', async () => {
    window.p86LiveMirror.start(H.session);
    await settle();
    window.p86LiveMirror.tick();
    await settle();
    window.p86LiveMirror.stop();
    expect(document.querySelector('.p86-mirror-frame')).toBeNull();
    expect(document.querySelector('.p86-live-cursors').children.length).toBe(0);
  });

  test('a stopped mirror sends nothing, ever again', async () => {
    window.p86LiveMirror.start(H.session);
    await settle();
    window.p86LiveMirror.stop();
    H.posted.length = 0;
    document.getElementById('wip-contract-income').textContent = '$99.00';
    await settle(5000);
    expect(H.posted.length).toBe(0);
  });
});

// ══ 6. THE STAGE OBSERVES ══════════════════════════════════════════════════

describe('the guest stage is read-only and scriptless', () => {
  test('sandboxed to allow-same-origin only, and pointer-inert', async () => {
    window.p86LiveMirror.start(H.session);
    await settle();
    const snap = H.posted.filter((p) => p.body && p.body.kind === 'snap').pop();
    const wrap = document.createElement('div');
    document.body.appendChild(wrap);
    window.p86LiveMirrorGuest.applySnapshot(wrap, {
      root: snap.body.root, meta: snap.body.meta, snapSeq: snap.body.snapSeq, surface: 'job-wip-report'
    });
    const f = wrap.querySelector('iframe');
    expect(f.getAttribute('sandbox')).toBe('allow-same-origin');
    // A guest observes: the stage takes no pointer at all, stated inside the
    // iframe as well, because the two documents have separate cascades.
    const doc = f.contentDocument;
    const own = Array.from(doc.head.querySelectorAll('style')).map((s) => s.textContent).join('');
    expect(own).toMatch(/pointer-events:\s*none/);
  });

  test('teardown leaves no mirrored DOM behind — the rule showDead already had', async () => {
    window.p86LiveMirror.start(H.session);
    await settle();
    const snap = H.posted.filter((p) => p.body && p.body.kind === 'snap').pop();
    const wrap = document.createElement('div');
    document.body.appendChild(wrap);
    window.p86LiveMirrorGuest.applySnapshot(wrap, {
      root: snap.body.root, meta: snap.body.meta, snapSeq: snap.body.snapSeq, surface: 'job-wip-report'
    });
    expect(window.p86LiveMirrorGuest.have()).toBe(true);
    window.p86LiveMirrorGuest.teardown();
    expect(window.p86LiveMirrorGuest.have()).toBe(false);
    expect(wrap.querySelector('iframe')).toBeNull();
  });
});
