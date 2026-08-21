/**
 * @jest-environment jsdom
 */
// The refresh heartbeat (js/refresh.js).
//
// The bug class this exists to kill is a PAIRING failure: a mutation patches
// the boot read-cache but never repaints (stale screen), or repaints but never
// patches the cache (repaints the OLD number, which reads as "it didn't save").
// So the tests that matter most are the ones that pin store-then-surface
// ordering, and the three cross-cutting rules that can only be enforced here:
// type-first coalescing, never-concurrent hydrates, and never repainting over
// a focused editor.

jest.useFakeTimers();

let P;
beforeAll(() => {
  require('../js/refresh.js');
  P = window.p86Refresh;
});

// ── shared source seams ─────────────────────────────────────────────────────
// Several checks here are SOURCE checks, not runtime ones, because the defects
// they catch are invisible at runtime: a registry path pointing at a namespace
// no module creates, a dispatcher target with no client entry, a mutation site
// that refreshes a surface twice. Hoisted to module scope so both the
// registry-honesty and door-coverage groups read the same files.
const fs = require('fs');
const path = require('path');
const REPO = path.join(__dirname, '..');

// ── WHICH DIRECTORIES COUNT AS "CLIENT CODE" ───────────────────────────────
// DERIVED FROM index.html, never written down here.
//
// This used to be `fs.readdirSync(js/)` while every comment below said "client
// code" and "EVERY file". index.html loads 121 local scripts from TWO
// directories — 119 from js/ and 2 from nodegraph/ (engine.js, ui.js) — and
// nodegraph/ contains ZERO p86Refresh calls tree-wide. Four bypass shapes
// injected into nodegraph/ui.js that each go RED in js/ were silently green,
// among them the store-then-surface pair in the Site Plan's CO
// building-allocation editor, which writes contract dollars.
//
// A hardcoded root list is the same defect as the hardcoded call-site list this
// suite already replaced one level up, so the roots are read from the page that
// does the loading: a third directory is scanned the day it is added, not the
// day someone remembers. Absolute/protocol-relative srcs (the pdf.js CDN tag)
// are skipped — not ours, not on disk.
//
// THE QUOTING IS NOT ASSUMED. This matched `src="…"` — double quotes only —
// which is a hardcoded assumption inside the one function whose entire job is to
// remove a hardcoded list. index.html has zero single-quoted and zero unquoted
// srcs today, so it was latent, never live; that is exactly when it costs ten
// characters instead of a directory-wide blind spot. Same class as the `js/`-only
// scan this derivation replaced, and as the `//`-in-a-string stripper bug below:
// a reader that quietly sees less than it claims to.
//
// ONE pattern, read by both callers. The duplicate copy in the coverage test
// below is how the two could have drifted into disagreeing about what a script
// tag is.
const INDEX_HTML = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
const SCRIPT_SRC = '<script[^>]*\\bsrc\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s"\'>]+))';
// Every LOCAL script src the page loads, cache-buster stripped. Absolute and
// protocol-relative are dropped here so no caller has to remember to.
function scriptSrcs(html) {
  const re = new RegExp(SCRIPT_SRC, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(String(html)))) {
    const src = m[1] || m[2] || m[3] || '';
    if (!src || /^(?:[a-z]+:)?\/\//i.test(src)) continue;
    out.push(src.split('?')[0]);                 // drop the ?v= cache-buster
  }
  return out;
}
function scriptRoots(html) {
  const roots = new Set();
  scriptSrcs(html).forEach((p) => {
    const i = p.lastIndexOf('/');
    if (i > 0) roots.add(p.slice(0, i));
  });
  return [...roots].sort();
}
const SCRIPT_ROOTS = scriptRoots(INDEX_HTML);
// The whole DIRECTORY is read, not just the files index.html happens to name:
// a module that is loaded dynamically, or added to the tree before its script
// tag, is still client code and still must not bypass the registry.
//
// File keys stay BARE for js/ (every check and allowlist entry below names them
// that way) and are directory-qualified for every other root.
const SOURCES = SCRIPT_ROOTS.reduce((acc, dir) => acc.concat(
  fs.readdirSync(path.join(REPO, dir))
    .filter((f) => f.endsWith('.js'))
    .map((f) => ({
      file: dir === 'js' ? f : dir + '/' + f,
      dir: dir,
      src: fs.readFileSync(path.join(REPO, dir, f), 'utf8')
    }))
), []);
const DISPATCHER_PATH = path.join(REPO, 'server', 'services', 'payload-dispatcher.js');
const DISPATCHER_SRC = fs.readFileSync(DISPATCHER_PATH, 'utf8');

// Strip `//` comments before scanning for call sites. Several modules quote the
// exact call they document as forbidden, and a scan that counted prose would
// fail on the explanation of the fix rather than on the defect.
//
// LINE COMMENTS ONLY, deliberately. The first version of this also stripped
// /* … */ and that was a silent hole: js/estimate-editor.js contains the string
// "application/pdf,image/*", whose `/*` opened a phantom block comment that ate
// every line up to the next real `*/` — including a live window.p86JobsHubRefresh()
// call, which the scan then reported as absent. A checker that quietly stops
// seeing things is worse than no checker, so this only removes what it can
// remove safely, and `codeOnly` has its own test below.
//
// CRLF IS NORMALISED FIRST, and that is not cosmetic. Every file in js/ is
// checked out with CRLF endings (core.autocrlf), and JS `.` does not match \r —
// so `//.*$` could never reach the end of a real line and this function stripped
// NOTHING on any actual source file in the repo. It only looked correct because
// its own fixtures were LF and because the one pattern it fed was
// `window.`-qualified while the prose that quotes the forbidden call uses the
// bare form. The moment the scan below widened to the bare form, every comment
// describing the fix would have been reported as an offender. Same failure
// shape as the phantom comment: a stripper that silently does nothing.
//
// THE STRIPPER IS A QUOTE-AWARE SCAN, NOT A REGEX, and that is the third
// version of this same lesson. The regex was
// `/(^|[^:"'`\\])\/\/.*$/` — cut at the first `//` not preceded by `:`, a quote
// or a backslash. The `:` is what kept `"http://x"` from tripping it, and it
// only worked because a URL always carries one. Any OTHER `//` inside a string
// literal ate the rest of the line: `var s = 'a//b'; p86JobsHubRefresh();` went
// green. Same class as the phantom block comment — a stripper that quietly stops
// seeing code. Verified against the tree at the time: no live instance, so this
// was latent, which is exactly when it is cheap to close.
//
// The scan tracks quote state (', ", `) with backslash escapes and cuts only at
// a `//` outside a string, so `http://`, `image/*` and `'a//b'` are all safe
// without a special case. A backslash outside a string also escapes, which is
// what keeps a regex literal's `\/\/` from reading as a comment.
//
// WHERE IT GIVES UP, stated rather than discovered: state resets per LINE, so a
// line whose quotes do not balance — a template literal opened here and closed
// below, or a regex character class holding a lone backtick — is kept WHOLE and
// any trailing comment on it is scanned as code. (One line in the tree does
// this today: js/voice-output.js's `` /`([^`]*)`/g `` markdown strip.) That
// direction can only ever produce a FALSE ALARM, never a miss, which is the
// only acceptable way for a checker to be wrong.
function codeOnly(src) {
  return String(src)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(stripLineComment)
    .join('\n');
}
function stripLineComment(line) {
  let q = 0;                                   // 0 = code, else the open quote char
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\') { i++; continue; }          // escape, in a string OR a regex literal
    if (q) { if (c === q) q = 0; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
    if (c === '/' && line[i + 1] === '/') return line.slice(0, i);
  }
  return line;
}

// A CALL to the hub refresh, in either form it can be written: `window.`-
// qualified or the bare global. The leading class excludes `.` and `$`/word
// chars so `foo.p86JobsHubRefresh(` is not counted, and requiring `(` means the
// assignment that DEFINES it is not counted either.
const HUB_CALL = /(^|[^\w.$])(?:window\.)?p86JobsHubRefresh\s*\(/g;

// The body of `function <name>(...) { ... }`, brace-balanced, so a check can
// count calls INSIDE one function instead of across a 1,200-line module where
// a legitimate call elsewhere would mask the one that matters. Run it on
// comment-stripped source: a prose brace would throw the balance off.
function fnBody(src, name) {
  const head = new RegExp('function\\s+' + name + '\\s*\\(');
  const m = head.exec(src);
  if (!m) return null;
  const open = src.indexOf('{', m.index + m[0].length);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open + 1, i);
  }
  return null;
}

// Every entity_type string that can reach the client in an applied payload's
// affected_targets. DERIVED FROM THE SERVER SOURCE, never hand-copied: a
// literal list here would go stale the first time someone adds a dispatcher
// target, which is precisely the failure these checks exist to catch.
//
// Two contributions, because the dispatcher has two shapes:
//   1. the DISPATCHERS map — the authoritative set of types that can be
//      WRITTEN. The bulk / conditional / skipped result rows echo
//      `target.entity_type` back verbatim, so every key here can surface.
//   2. `entity_type: '<literal>'` in the returned result objects — this also
//      picks up 'move', which is a target-level op with no DISPATCHERS key.
//
// The two are kept SEPARATE rather than merged in one pass, because their union
// cannot tell you whether both are alive. Today every DISPATCHERS key also
// appears as a literal, so the map contributes nothing UNIQUE to the union: if
// its regex rots the union does not shrink by a single type, and an assertion
// on the union (or on named canaries like `assembly` / `job`) still passes on
// the literals alone. Proven by breaking the map regex and adding a map-only
// target — the whole group stayed green. So each contribution is asserted on
// its OWN size below.
function dispatcherMapKeys() {
  const out = new Set();
  const map = DISPATCHER_SRC.match(/const DISPATCHERS\s*=\s*\{([\s\S]*?)\n\};/);
  if (map) (map[1].match(/^\s*([a-z_]+)\s*:/gm) || [])
    .forEach((m) => out.add(m.replace(/[\s:]/g, '')));
  return out;
}
function dispatcherLiteralTypes() {
  const out = new Set();
  (DISPATCHER_SRC.match(/entity_type:\s*'([a-z_]+)'/g) || [])
    .forEach((m) => out.add(m.replace(/.*'([a-z_]+)'.*/, '$1')));
  return out;
}
function emittedEntityTypes() {
  return new Set([...dispatcherMapKeys(), ...dispatcherLiteralTypes()]);
}

// Emitted types that deliberately refresh NOTHING. Each carries its reason,
// because "we forgot to wire it" and "there is nothing on screen to wire"
// look identical from the outside — that ambiguity is how `assembly` sat
// unwired through a sweep whose stated goal was "everywhere".
const META_TYPES = {
  move: 'A summary receipt pushed AFTER both halves of the move have already ' +
        'emitted their own concrete targets (runTarget in payload-dispatcher.js). ' +
        'Refreshing on it would repaint those surfaces a second time.',
  system: 'Org/system settings multi-op. Not a row: it has no single backing ' +
        'table (it is absent from TABLE_FOR_ENTITY for the same reason) and no ' +
        'client read-cache to patch.',
  deal_memory: 'Append-only notes on a deal lineage, read server-side when a ' +
        'deal thread assembles its context. No client surface renders them.',
};

// Drain the coalescing window AND any promise microtasks the run chains on.
async function settle() {
  jest.advanceTimersByTime(300);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  document.body.innerHTML = '';
  window.appData = { jobPurchaseOrders: [], jobChangeOrders: [], jobVendorBills: [], arInvoices: [] };
  window.appState = {};
  [
    'renderJobsMain', 'p86JobsHubRefresh', 'p86RepaintJobMoneyTabs', 'p86JobDetailRefresh',
    'loadPurchaseOrdersForJob', 'loadChangeOrdersForJob', 'loadBillsForJob',
    'reloadLeadsCache', 'reloadClientsCache', 'p86ReloadAllData', 'p86DataLoading',
    'p86InvoicesSyncStore', 'p86RemountReceiptRollups', 'renderSchedule',
    'renderSummaryDashboard'
  ].forEach((k) => { delete window[k]; });
  window.p86Tasks = undefined;
  window.p86MyDay = undefined;
  window.p86Subs = undefined;
});

// ── the scanned roots are the roots the app loads ───────────────────────────
// Every source check below is only as wide as SOURCES. It was `js/` while its
// comments said "client code", and nodegraph/ — two files, 10k lines, the Site
// Plan and its money editors — was a blind spot no test could report, because
// a file that is not read cannot fail anything.
describe('scanned roots', () => {
  test('the roots come from index.html, and nodegraph is one of them', () => {
    expect(SCRIPT_ROOTS).toEqual(['js', 'nodegraph']);
    // Asserted by name as well as by list: if someone re-narrows the derivation,
    // "it still returns something" is not the property that matters.
    expect(SCRIPT_ROOTS).toContain('nodegraph');
  });

  test('every local script index.html loads is in a scanned root', () => {
    const loaded = scriptSrcs(INDEX_HTML);
    // No local tag may sit outside the scanned set — that is the exact failure
    // shape, one directory at a time.
    const outside = loaded.filter((p) => SCRIPT_ROOTS.indexOf(p.slice(0, p.lastIndexOf('/'))) === -1);
    expect(outside).toEqual([]);
    // ...and every one of them is a file the scan actually holds.
    const keys = new Set(SOURCES.map((s) => s.file));
    const unread = loaded.filter((p) => {
      const dir = p.slice(0, p.lastIndexOf('/')), base = p.slice(p.lastIndexOf('/') + 1);
      return !keys.has(dir === 'js' ? base : dir + '/' + base);
    });
    expect(unread).toEqual([]);
    expect(loaded.length).toBeGreaterThanOrEqual(120);
  });

  test('the derivation ignores external scripts and survives a new directory', () => {
    // Pure, so it can be run against HTML the tree does not contain.
    expect(scriptRoots('<script src="https://cdn.example.com/x/pdf.min.js"></script>')).toEqual([]);
    expect(scriptRoots('<script src="//cdn.example.com/x/pdf.min.js"></script>')).toEqual([]);
    // A THIRD directory is picked up with no edit here — the property the
    // hardcoded list could not have.
    expect(scriptRoots('<script src="js/a.js?v=1"></script><script src="widgets/b.js"></script>'))
      .toEqual(['js', 'widgets']);
    // A root-level script has no directory to scan and must not become "".
    expect(scriptRoots('<script src="sw.js"></script>')).toEqual([]);
  });

  test('the derivation does not assume double quotes', () => {
    // C4. The regex required `src="…"`. index.html has no single-quoted or
    // unquoted src today, so this was latent — but a hardcoded quoting
    // assumption inside the function that exists to delete a hardcoded list is
    // the same defect one level down, and it costs ten characters to close.
    expect(scriptRoots("<script src='widgets/b.js'></script>")).toEqual(['widgets']);
    expect(scriptRoots('<script src=widgets/b.js></script>')).toEqual(['widgets']);
    expect(scriptRoots("<script src='js/a.js?v=3'></script>")).toEqual(['js']);
    // Whatever the quoting, external is still external.
    expect(scriptRoots("<script src='https://cdn.example.com/x/pdf.min.js'></script>")).toEqual([]);
    expect(scriptRoots('<script src=//cdn.example.com/x/pdf.min.js></script>')).toEqual([]);
    // Mixed quoting in one document, which is how it would actually arrive.
    expect(scriptRoots('<script src="js/a.js"></script><script src=\'nodegraph/b.js\'></script>'))
      .toEqual(['js', 'nodegraph']);
    // And the srcs list itself — the thing the coverage test above reads.
    expect(scriptSrcs("<script src='js/a.js?v=9'></script>")).toEqual(['js/a.js']);
    // A tag with no src contributes nothing rather than an empty string.
    expect(scriptSrcs('<script>var x = 1;</script>')).toEqual([]);
    expect(scriptSrcs('<script src=""></script>')).toEqual([]);
  });
});

// ── the pairing: store patch AND surface repaint, in that order ──────────────
describe('store-then-surface — the pairing that IS the bug class', () => {
  test('a PO refresh patches the store AND repaints, never one without the other', async () => {
    const order = [];
    window.loadPurchaseOrdersForJob = jest.fn(() => { order.push('store'); return Promise.resolve(); });
    window.renderJobsMain = jest.fn(() => { order.push('surface'); });

    P('po', { jobId: 'job_1' });
    await settle();

    expect(window.loadPurchaseOrdersForJob).toHaveBeenCalled();
    expect(window.renderJobsMain).toHaveBeenCalled();
    expect(order).toEqual(['store', 'surface']);
  });

  test('the surface waits for a SLOW store — repainting first shows the pre-write number', async () => {
    const order = [];
    let release;
    window.loadPurchaseOrdersForJob = jest.fn(() => {
      order.push('store-start');
      return new Promise((res) => { release = () => { order.push('store-done'); res(); }; });
    });
    window.renderJobsMain = jest.fn(() => { order.push('surface'); });

    P('po', { jobId: 'job_1' });
    jest.advanceTimersByTime(300);
    await Promise.resolve();
    expect(order).toEqual(['store-start']);   // surface has NOT run yet

    release();
    await settle();
    expect(order).toEqual(['store-start', 'store-done', 'surface']);
  });

  test('a store that REJECTS still repaints — a failed refetch must not freeze the screen', async () => {
    window.loadBillsForJob = jest.fn(() => Promise.reject(new Error('offline')));
    window.renderJobsMain = jest.fn();

    P('bill', { jobId: 'job_1' });
    await settle();

    expect(window.renderJobsMain).toHaveBeenCalled();
  });

  test('money refreshes force a fresh fetch — joining a pre-write GET returns stale rows', async () => {
    window.loadPurchaseOrdersForJob = jest.fn(() => Promise.resolve());
    P('po', { jobId: 'job_7' });
    await settle();
    // second arg is the `force` flag on loadXForJob
    expect(window.loadPurchaseOrdersForJob).toHaveBeenCalledWith('job_7', true);
  });
});

// ── coalescing is TYPE-first, because targets arrive one per changed ROW ─────
describe('coalescing', () => {
  test('40 targets of one type run the refresh ONCE, not 40 times', async () => {
    window.loadChangeOrdersForJob = jest.fn(() => Promise.resolve());
    window.renderJobsMain = jest.fn();

    for (let i = 0; i < 40; i++) P('co', { id: 'co_' + i, jobId: 'job_1' });
    await settle();

    expect(window.renderJobsMain).toHaveBeenCalledTimes(1);
  });

  test('job + estimate share ONE bucket, so a payload touching both hydrates once', async () => {
    window.p86ReloadAllData = jest.fn();

    P('job', { id: 'j1' });
    P('estimate', { id: 'e1' });
    await settle();

    expect(window.p86ReloadAllData).toHaveBeenCalledTimes(1);
  });

  test('task, todo, reminder and calendar_event share a bucket — one repaint, not four', async () => {
    window.p86Tasks = { refresh: jest.fn() };

    P('task'); P('todo'); P('reminder'); P('calendar_event');
    await settle();

    expect(window.p86Tasks.refresh).toHaveBeenCalledTimes(1);
  });

  test('different buckets do NOT collapse into each other', async () => {
    window.reloadLeadsCache = jest.fn();
    window.reloadClientsCache = jest.fn();

    P('lead'); P('client');
    await settle();

    expect(window.reloadLeadsCache).toHaveBeenCalledTimes(1);
    expect(window.reloadClientsCache).toHaveBeenCalledTimes(1);
  });
});

// ── never two concurrent appData hydrates ───────────────────────────────────
describe('hydrate serialisation', () => {
  test('no hydrate starts while one is in flight — a second re-seeds stale rows from cache', async () => {
    let loading = true;
    window.p86DataLoading = () => loading;
    window.p86ReloadAllData = jest.fn();

    P('job', { id: 'j1' });
    await settle();
    expect(window.p86ReloadAllData).not.toHaveBeenCalled();   // deferred, not dropped

    loading = false;
    jest.advanceTimersByTime(600);
    await Promise.resolve();
    expect(window.p86ReloadAllData).toHaveBeenCalledTimes(1);  // and it DID run
  });

  test('a deferred hydrate cannot spin forever if the in-flight flag wedges', async () => {
    window.p86DataLoading = () => true;   // never clears
    window.p86ReloadAllData = jest.fn();

    P('job', { id: 'j1' });
    await settle();
    jest.advanceTimersByTime(60000);
    await Promise.resolve();

    // Bounded: it gives up waiting and runs rather than polling forever.
    expect(window.p86ReloadAllData).toHaveBeenCalledTimes(1);
  });
});

// ── the focus guard: never repaint the container holding the caret ───────────
describe('isTyping — the guard that stops a refresh eating a half-typed row', () => {
  test('true when the caret is inside the container', () => {
    document.body.innerHTML = '<div id="ed"><input id="f"></div>';
    document.getElementById('f').focus();
    expect(P.isTypingIn('#ed')).toBe(true);
  });

  test('false when focus is elsewhere', () => {
    document.body.innerHTML = '<div id="ed"><input id="f"></div><input id="other">';
    document.getElementById('other').focus();
    expect(P.isTypingIn('#ed')).toBe(false);
  });

  test('false for a focused non-input (a button press must not block a repaint)', () => {
    document.body.innerHTML = '<div id="ed"><button id="b">x</button></div>';
    document.getElementById('b').focus();
    expect(P.isTypingIn('#ed')).toBe(false);
  });

  test('true for contenteditable — the rich-text scope editor is not an <input>', () => {
    document.body.innerHTML = '<div id="ed"><div id="rt" contenteditable="true"></div></div>';
    const rt = document.getElementById('rt');
    Object.defineProperty(rt, 'isContentEditable', { value: true });
    rt.focus();
    expect(P.isTypingIn('#ed')).toBe(true);
  });

  test('false for a selector that matches nothing', () => {
    expect(P.isTypingIn('#nope')).toBe(false);
  });
});

// ── fromTargets: the AI door ────────────────────────────────────────────────
describe('fromTargets — the agent-write fan-out', () => {
  test('dispatches every entity type in the payload, not just the four that used to be wired', async () => {
    window.p86ReloadAllData = jest.fn();
    window.reloadLeadsCache = jest.fn();
    window.p86Tasks = { refresh: jest.fn() };

    P.fromTargets([
      { entity_type: 'job', entity_id: 'j1' },
      { entity_type: 'lead', entity_id: 'l1' },
      { entity_type: 'task', entity_id: 't1' }      // had NO arm before
    ], 'pay_1');
    await settle();

    expect(window.p86ReloadAllData).toHaveBeenCalled();
    expect(window.reloadLeadsCache).toHaveBeenCalled();
    expect(window.p86Tasks.refresh).toHaveBeenCalled();
  });

  test('the same payload arriving through both doors refreshes once', async () => {
    window.reloadLeadsCache = jest.fn();

    expect(P.fromTargets([{ entity_type: 'lead', entity_id: 'l1' }], 'pay_dupe')).toBe(true);
    expect(P.fromTargets([{ entity_type: 'lead', entity_id: 'l1' }], 'pay_dupe')).toBe(false);
    await settle();

    expect(window.reloadLeadsCache).toHaveBeenCalledTimes(1);
  });

  test('an unknown entity type is a no-op, never a throw', async () => {
    expect(() => P.fromTargets([{ entity_type: 'wormhole', entity_id: 'x' }], 'pay_2')).not.toThrow();
    await settle();
  });

  test('missing targets and a missing payload id are both survivable', async () => {
    expect(() => P.fromTargets(undefined, undefined)).not.toThrow();
    expect(() => P.fromTargets([null, {}], null)).not.toThrow();
    await settle();
  });
});

// ── resilience: a broken surface must not take the rest down ────────────────
describe('isolation', () => {
  test('a throwing surface does not prevent later refreshes', async () => {
    window.reloadLeadsCache = jest.fn(() => { throw new Error('boom'); });
    window.reloadClientsCache = jest.fn();

    P('lead'); P('client');
    await settle();

    expect(window.reloadClientsCache).toHaveBeenCalled();
  });

  test('every registered type survives having no primitives defined at all', async () => {
    for (const t of P.types()) expect(() => P(t, { id: 'x' })).not.toThrow();
    await settle();
  });
});

// ── which job a money row belongs to ────────────────────────────────────────
describe('job resolution for the per-job money mirrors', () => {
  test('resolves the job from the mirror when the caller did not say', async () => {
    window.appData.jobPurchaseOrders = [{ id: 'po_9', job_id: 'job_from_mirror' }];
    window.loadPurchaseOrdersForJob = jest.fn(() => Promise.resolve());

    P('po', { id: 'po_9' });
    await settle();

    expect(window.loadPurchaseOrdersForJob).toHaveBeenCalledWith('job_from_mirror', true);
  });

  test('falls back to the job on screen for a row that is not cached yet', async () => {
    window.appState.currentJobId = 'job_open';
    window.loadBillsForJob = jest.fn(() => Promise.resolve());

    P('bill', { id: 'brand_new' });
    await settle();

    expect(window.loadBillsForJob).toHaveBeenCalledWith('job_open', true);
  });

  test('an explicit jobId always wins over the mirror', async () => {
    window.appData.jobChangeOrders = [{ id: 'co_1', job_id: 'job_stale' }];
    window.loadChangeOrdersForJob = jest.fn(() => Promise.resolve());

    P('co', { id: 'co_1', jobId: 'job_explicit' });
    await settle();

    const jobs = window.loadChangeOrdersForJob.mock.calls.map((c) => c[0]);
    expect(jobs).toContain('job_explicit');
  });

  test('the open job page repaints when the changed row belongs to it', async () => {
    window.appState.currentJobId = 'job_open';
    window.loadBillsForJob = jest.fn(() => Promise.resolve());
    window.p86RepaintJobMoneyTabs = jest.fn();

    P('bill', { jobId: 'job_open' });
    await settle();

    expect(window.p86RepaintJobMoneyTabs).toHaveBeenCalledWith('job_open');
  });

  test('the open job page does NOT repaint when a DIFFERENT job changed', async () => {
    window.appState.currentJobId = 'job_open';
    window.loadBillsForJob = jest.fn(() => Promise.resolve());
    window.p86RepaintJobMoneyTabs = jest.fn();

    P('bill', { jobId: 'job_other' });
    await settle();

    expect(window.p86RepaintJobMoneyTabs).not.toHaveBeenCalled();
  });
});

// ── exactly ONCE per mutation ───────────────────────────────────────────────
// A double repaint is a defect, not a cost: it flickers, it can steal focus and
// it can drop a half-typed row — the same reason the old setTimeout repaints
// were deleted. So these assert COUNTS, never truthiness.
describe('one mutation repaints each surface exactly once', () => {
  test('a PO edit refetches once and repaints the jobs list + hub once each', async () => {
    window.loadPurchaseOrdersForJob = jest.fn(() => Promise.resolve());
    window.renderJobsMain = jest.fn();
    window.p86JobsHubRefresh = jest.fn();

    P('po', { jobId: 'job_1' });
    await settle();

    expect(window.loadPurchaseOrdersForJob).toHaveBeenCalledTimes(1);
    expect(window.renderJobsMain).toHaveBeenCalledTimes(1);
    expect(window.p86JobsHubRefresh).toHaveBeenCalledTimes(1);
  });

  test('a CO edit repaints the hub once', async () => {
    window.loadChangeOrdersForJob = jest.fn(() => Promise.resolve());
    window.p86JobsHubRefresh = jest.fn();

    P('co', { jobId: 'job_1' });
    await settle();

    expect(window.p86JobsHubRefresh).toHaveBeenCalledTimes(1);
  });

  test('an invoice edit repaints the jobs list once — the store half must not paint it too', async () => {
    // p86InvoicesSyncStore refetches /invoices and patches appData.arInvoices.
    // When it ALSO called renderJobsMain, this ran twice for one edit.
    window.p86InvoicesSyncStore = jest.fn(() => Promise.resolve());
    window.renderJobsMain = jest.fn();

    P('invoice', { jobId: 'job_1' });
    await settle();

    expect(window.p86InvoicesSyncStore).toHaveBeenCalledTimes(1);
    expect(window.renderJobsMain).toHaveBeenCalledTimes(1);
  });

  test('a full job-detail refresh SUPPRESSES the narrow money repaint — it is a superset', async () => {
    window.appState.currentJobId = 'job_open';
    window.loadPurchaseOrdersForJob = jest.fn(() => Promise.resolve());
    window.p86JobDetailRefresh = jest.fn(() => true);    // the latch fired
    window.p86RepaintJobMoneyTabs = jest.fn();

    P('po', { jobId: 'job_open' });
    await settle();

    expect(window.p86JobDetailRefresh).toHaveBeenCalledTimes(1);
    // renderJobDetail already repaints the money sections. Running both painted
    // renderPurchaseOrders / renderChangeOrders / renderInvoices twice.
    expect(window.p86RepaintJobMoneyTabs).not.toHaveBeenCalled();
  });

  test('...but a human edit (latch not set) still gets its ONE repaint', async () => {
    window.appState.currentJobId = 'job_open';
    window.loadPurchaseOrdersForJob = jest.fn(() => Promise.resolve());
    window.p86JobDetailRefresh = jest.fn(() => false);   // no pending write
    window.p86RepaintJobMoneyTabs = jest.fn();

    P('po', { jobId: 'job_open' });
    await settle();

    expect(window.p86RepaintJobMoneyTabs).toHaveBeenCalledTimes(1);
  });

  test('NO module outside the registry fires the hub refresh — scanned, not enumerated', () => {
    // The regression this guards is a CALL-SITE one: an editor calls
    // p86JobsHubRefresh() and THEN p86Refresh(...), whose surface calls it
    // again. Two hub refetches and two repaints, 200ms apart, per edit.
    //
    // This used to name purchase-order-editor.js and change-order-editor.js by
    // hand — and estimate-editor.js sat outside that list with a live call for
    // a whole release. An invariant enforced by enumerating call sites leaks,
    // so the check now walks EVERY file in js/.
    //
    // js/refresh.js is now the ONLY exclusion. jobs-hub.js used to be a second
    // one because its own bill editor reloaded the list it had just written to;
    // that path routes through p86Refresh.now('bill') instead, so the exception
    // is gone rather than grandfathered — the module that DEFINES the function
    // is held to the same rule as everything else.
    //
    // The pattern matches the BARE global as well as the window.-qualified
    // form. p86JobsHubRefresh IS a global, so `p86JobsHubRefresh()` on its own
    // was a call this scan could not see: "enforced, not remembered" was only
    // three-quarters true.
    const offenders = SOURCES
      .filter((s) => s.file !== 'refresh.js')
      .map((s) => ({ file: s.file, calls: (codeOnly(s.src).match(HUB_CALL) || []).length }))
      .filter((s) => s.calls > 0);
    expect(offenders).toEqual([]);
  });

  test('...and that scan can actually see a call — it is not matching nothing', () => {
    // Guards the guard: if codeOnly() or the pattern ever stopped matching, the
    // test above would pass on a codebase full of offenders.
    expect('window.p86JobsHubRefresh();'.match(HUB_CALL)).toHaveLength(1);
    // The bare global — the form the old pattern was blind to.
    expect('  p86JobsHubRefresh();'.match(HUB_CALL)).toHaveLength(1);
    expect('if (x) p86JobsHubRefresh();'.match(HUB_CALL)).toHaveLength(1);
    // ...but the DEFINITION is not a call, or the owner would report itself.
    expect('window.p86JobsHubRefresh = function () { refetch(true); };'.match(HUB_CALL)).toBeNull();
    // Comments in the money editors deliberately quote the old bad call, so the
    // scan must read code only or it would fail on prose describing the fix.
    expect(codeOnly('// used to call window.p86JobsHubRefresh() itself')).not.toContain('p86JobsHubRefresh');
    expect(codeOnly('  // a bare p86JobsHubRefresh() repainted from a stale store')).not.toContain('p86JobsHubRefresh');
    // CRLF: every file in js/ is checked out with \r\n, and JS `.` does not
    // match \r — so `//.*$` could not reach end-of-line and codeOnly stripped
    // nothing at all on real source. With the bare form now in the pattern,
    // that hole would have failed this suite on prose in four modules.
    expect(codeOnly('  // calls p86JobsHubRefresh() itself\r\nvar x = 1;')).not.toContain('p86JobsHubRefresh');
    // The regression that made this scan blind: a `/*` inside a STRING must not
    // hide the code that follows it. This is the exact shape in
    // estimate-editor.js — accept="application/pdf,image/*" — which swallowed a
    // live call and made the scan report a clean file.
    const trap = 'var a = "application/pdf,image/*";\nwindow.p86JobsHubRefresh();';
    expect(codeOnly(trap).match(HUB_CALL)).toHaveLength(1);
    // And with the trap in CRLF, which is how it actually sits on disk.
    const trapCrlf = 'var a = "application/pdf,image/*";\r\nwindow.p86JobsHubRefresh();\r\n';
    expect(codeOnly(trapCrlf).match(HUB_CALL)).toHaveLength(1);
  });

  test('a `//` inside a STRING does not swallow the code after it', () => {
    // The hole the old regex stripper had. It cut at the first `//` not preceded
    // by `:`/quote/backslash — and the `:` exclusion is the ONLY reason
    // "http://x" survived. Any other `//` in a literal ate the rest of the line,
    // so the call below reported as absent and the file read clean. Latent when
    // found (no live instance in the tree), fixtured here so it stays that way.
    expect(codeOnly("var s = 'a//b'; p86JobsHubRefresh();").match(HUB_CALL)).toHaveLength(1);
    expect(codeOnly('var s = "a//b"; p86JobsHubRefresh();').match(HUB_CALL)).toHaveLength(1);
    expect(codeOnly('var s = `a//b`; p86JobsHubRefresh();').match(HUB_CALL)).toHaveLength(1);
    // ...and the URL case the `:` hack existed for still works, for the real
    // reason this time: it is inside a string.
    expect(codeOnly('var u = "http://x"; p86JobsHubRefresh();').match(HUB_CALL)).toHaveLength(1);
    // A real comment is still a comment — including one whose text contains an
    // apostrophe, which is where a naive quote scanner would flip state and keep
    // the whole line.
    expect(codeOnly("  // don't call p86JobsHubRefresh() here")).not.toContain('p86JobsHubRefresh');
    expect(codeOnly('var x = 1; // p86JobsHubRefresh() used to run here')).not.toContain('p86JobsHubRefresh');
    // An escaped quote inside a string must not end it.
    expect(codeOnly("var s = 'it\\'s // fine'; p86JobsHubRefresh();").match(HUB_CALL)).toHaveLength(1);
    // A regex literal's escaped slashes are not a comment.
    expect(codeOnly('var r = /https?:\\/\\//; p86JobsHubRefresh();').match(HUB_CALL)).toHaveLength(1);
  });

  test('an UNBALANCED line is kept whole — the stripper fails loud, never quiet', () => {
    // A template literal opened on one line and closed on another leaves the
    // quote state open at end-of-line. The scan does not guess: it keeps the
    // line, so a trailing comment there is read as code. That can only raise a
    // false alarm, never hide a call — which is the only direction a checker is
    // allowed to be wrong in. js/voice-output.js has exactly one such line.
    const open = 'var t = `line one';
    expect(codeOnly(open + ' // not stripped')).toContain('not stripped');
    // The consequence, named: a call quoted in a comment on such a line WOULD
    // be reported. No file in the tree does that today, and the scan below would
    // fail rather than pass if one did.
    expect(codeOnly('var t = `x // p86JobsHubRefresh()').match(HUB_CALL)).toHaveLength(1);
  });
});

// ── a bulk action touches N jobs, not just the last one ─────────────────────
describe('coalescing keeps every job, not the last', () => {
  test('three jobs changed in one window all get their store patched', async () => {
    window.loadBillsForJob = jest.fn(() => Promise.resolve());

    P('bill', { jobId: 'job_a' });
    P('bill', { jobId: 'job_b' });
    P('bill', { jobId: 'job_c' });
    await settle();

    const jobs = window.loadBillsForJob.mock.calls.map((c) => c[0]).sort();
    // Collapsing opts.jobId last-wins meant job_a and job_b silently kept their
    // pre-write rows while the surface repainted and reported success.
    expect(jobs).toEqual(['job_a', 'job_b', 'job_c']);
  });
});

// ── every entry must be REACHABLE and point at something REAL ───────────────
describe('registry honesty', () => {
  // A path is "published" when some module in js/ assigns its root onto window
  // (or declares it as a top-level function), and — for a dotted path — that
  // same module names the member. This is deliberately a SOURCE check: the
  // defect it exists to catch is `report -> p86Reports.refresh`, a namespace no
  // module has ever created, which no runtime stub could ever reveal.
  function publishedBy(dotted) {
    const [root, member] = String(dotted).split('.');
    const rootRe = new RegExp('(?:window\\.' + root + '\\s*=)|(?:^\\s*function\\s+' + root + '\\s*\\()', 'm');
    const owners = SOURCES.filter((s) => rootRe.test(s.src));
    if (!owners.length) return null;
    if (!member) return owners.map((o) => o.file);
    const memberRe = new RegExp('(?:^|[^\\w.$])' + member + '\\s*[:=]', 'm');
    const withMember = owners.filter((o) => memberRe.test(o.src));
    return withMember.length ? withMember.map((o) => o.file) : null;
  }

  test('every path the registry can call is actually published by a module', () => {
    const dead = P.paths().filter((p) => !publishedBy(p));
    expect(dead).toEqual([]);
  });

  test('the check is real — a path nobody publishes is reported dead', () => {
    // The exact entry that shipped: window.p86Reports does not exist anywhere.
    expect(publishedBy('p86Reports.refresh')).toBeNull();
    expect(publishedBy('renderJobsMain')).not.toBeNull();
  });

  test('every type is reachable — a dispatcher target or a p86Refresh() call site', () => {
    const emitted = emittedEntityTypes();
    const clientCalls = new Set();
    SOURCES.filter((s) => s.file !== 'refresh.js').forEach((s) => {
      (s.src.match(/p86Refresh\(\s*'([a-z_]+)'/g) || [])
        .forEach((m) => clientCalls.add(m.replace(/.*'([a-z_]+)'.*/, '$1')));
    });
    // TWO files dispatch the type indirectly, through a literal map — three
    // sites in total. Read the maps rather than loosening the scan above into
    // a string search that would wave anything through.
    //
    //   jobs-hub.js:351,352   p86Refresh(type, ...)  off BULK_REFRESH_TYPE
    //   doc-import.js:562     p86Refresh(type, ...)  off REFRESH_TYPE
    //
    // Reading BOTH matters, and `bill` is why. `bill` is not a dispatcher
    // target at all — absent from DISPATCHERS and from the entity_type
    // literals — so its only reachability evidence is a client call site. It
    // survives today because BULK_REFRESH_TYPE happens to name it; if that hub
    // map ever dropped 'bill', this test would call `bill` unreachable while
    // doc-import.js was actively dispatching it. Two maps, one fact.
    const INDIRECT = [
      ['jobs-hub.js', /BULK_REFRESH_TYPE\s*=\s*\{([\s\S]*?)\}/],
      ['doc-import.js', /REFRESH_TYPE\s*=\s*\{([\s\S]*?)\}/],
    ];
    INDIRECT.forEach(([file, re]) => {
      const src = SOURCES.find((s) => s.file === file);
      expect(`${file} is scanned`).toBe(src ? `${file} is scanned` : 'MISSING');
      const map = src.src.match(re);
      expect(map).not.toBeNull();
      (map[1].match(/:\s*'([a-z_]+)'/g) || [])
        .forEach((m) => clientCalls.add(m.replace(/.*'([a-z_]+)'.*/, '$1')));
    });
    const unreachable = P.types().filter((t) => !emitted.has(t) && !clientCalls.has(t));
    // `sub` and `project` were exactly this: entries no door could ever fire.
    expect(unreachable).toEqual([]);
  });

  test('every entry declares at least one path', () => {
    const bare = P.types().filter((t) => P.paths(t).length === 0);
    expect(bare).toEqual([]);
  });

  test('the report entry refreshes both surfaces a report can live on', async () => {
    window.appState.currentJobId = 'job_open';
    window.p86Projects = { refreshReports: jest.fn() };
    window.p86JobReportsRefresh = jest.fn();

    P('report', { id: 'rep_1' });
    await settle();

    expect(window.p86Projects.refreshReports).toHaveBeenCalledTimes(1);
    expect(window.p86JobReportsRefresh).toHaveBeenCalledTimes(1);

    delete window.p86Projects;
    delete window.p86JobReportsRefresh;
  });
});

// ── the Jobs Hub bulk bar: one refresh per action, and no visible blank ─────
// The registry surface reaches p86JobsHubRefresh() -> _currentRefetch() ->
// the hub's own refetch. A bulk handler that ALSO called refetch() therefore
// ran cfg.fetch twice ~200ms apart — and because refetch blanks the list to
// "Loading…" first, this double was the one the user could see.
//
// These are source checks that COUNT, because the two failure modes are
// "twice" and "zero" and both pass a truthiness check. They are scoped to a
// single function body rather than the whole module, so an unrelated refetch
// elsewhere can neither mask a regression nor cause a false alarm.
describe('the Jobs Hub bulk bar', () => {
  const HUB = codeOnly(SOURCES.find((s) => s.file === 'jobs-hub.js').src);

  test('both bulk actions funnel through afterBulk — neither refreshes on its own', () => {
    ['bulkSetStatus', 'bulkDelete'].forEach((name) => {
      const body = fnBody(HUB, name);
      expect({ fn: name, found: body !== null }).toEqual({ fn: name, found: true });
      // Anchor: prove we extracted the right function before counting in it.
      expect(body).toContain('bulkConfirm(');
      expect({ fn: name, refetch: (body.match(/\brefetch\s*\(/g) || []).length })
        .toEqual({ fn: name, refetch: 0 });
      expect({ fn: name, storeRefresh: (body.match(/\bbulkRefreshBillStore\s*\(/g) || []).length })
        .toEqual({ fn: name, storeRefresh: 0 });
      expect({ fn: name, afterBulk: (body.match(/\bafterBulk\s*\(/g) || []).length })
        .toEqual({ fn: name, afterBulk: 1 });
    });
  });

  test('afterBulk refreshes the list exactly once, and only when the registry will not', () => {
    const body = fnBody(HUB, 'afterBulk');
    expect(body).not.toBeNull();
    expect({ refetch: (body.match(/\brefetch\s*\(/g) || []).length }).toEqual({ refetch: 1 });
    // The surviving call is the FALLBACK, not the primary. This is the half
    // that matters most: bulkRefreshBillStore returns false when the list has
    // no refresh type or the registry isn't loaded, and a hub that refreshes
    // zero times is worse than one that refreshes twice.
    expect(body).toMatch(/if\s*\(\s*!\s*bulkRefreshBillStore\s*\(\s*ids\s*\)\s*\)\s*refetch\s*\(/);
  });

  test('bulkRefreshBillStore reports whether the registry actually took the write', () => {
    const body = fnBody(HUB, 'bulkRefreshBillStore');
    expect(body).not.toBeNull();
    // Every early exit that skips the registry must answer false, or afterBulk
    // would trust a refresh that never happens.
    expect(body).toMatch(/if\s*\(!type\s*\|\|\s*!window\.p86Refresh\)\s*return false;/);
    expect({ falses: (body.match(/return false;/g) || []).length }).toEqual({ falses: 1 });
    expect({ trues: (body.match(/return true;/g) || []).length }).toEqual({ trues: 2 });
  });

  test('a data-changed refetch does not blank the list to Loading…', () => {
    // p86JobsHubRefresh -> _currentRefetch, which must ask for the quiet form.
    expect(HUB).toMatch(/_currentRefetch\s*=\s*function\s*\(\s*\)\s*\{\s*refetch\(true\);\s*\}/);
    const body = fnBody(HUB, 'refetch');
    expect(body).not.toBeNull();
    expect(body).toMatch(/if\s*\(listEl\s*&&\s*!quiet\)/);
    // Exactly one place can paint the spinner, and it is behind that gate.
    expect({ blanks: (body.match(/jobshub-loading/g) || []).length }).toEqual({ blanks: 1 });
  });

  test('user-initiated loads still show the wait — quiet must not become the default', () => {
    // First paint, both filter selects, and the create modal: four explicit
    // loud loads. Losing these would trade a flicker for a dead-looking page.
    expect({ loud: (HUB.match(/\brefetch\(false\)/g) || []).length }).toEqual({ loud: 4 });
  });
});

// ── THE INVERSE DIRECTION: door → registry ──────────────────────────────────
// Everything above walks registry → door: each declared entry must be real and
// reachable. Nothing checked the other way — that every entity type the SERVER
// dispatcher can emit HAS an entry. That blind spot is exactly why `assembly`
// slipped through a sweep whose stated goal was "everywhere": an agent could
// create, retune or delete a cost recipe and not one surface moved, and every
// registry→door test still passed, because the missing entry was not there to
// be wrong about.
//
// The list of doors is derived from server/services/payload-dispatcher.js, not
// written down here. A hardcoded expectation would rot the first time someone
// added a target — which is the failure this exists to catch.
describe('door → registry: every type the dispatcher can emit is handled', () => {
  // Pure so the "does the check bite" test can run it against a mutilated
  // registry without touching the real one.
  function unhandled(emitted, registered) {
    return [...emitted].filter((t) => !registered.has(t) && !META_TYPES[t]).sort();
  }

  test('the derivation really reads the dispatcher — an empty scrape must not pass silently', () => {
    // EACH CONTRIBUTION IS ASSERTED ON ITS OWN SIZE. The previous version of
    // this test asserted on the UNION and claimed "if either regex rots, one of
    // these goes missing" — which was false. Every DISPATCHERS key is ALSO an
    // `entity_type: '<literal>'` in a result row, so the map contributes zero
    // unique types: with the map regex broken the union is unchanged and all
    // four named canaries (assembly / deal_memory / move / job) survive on the
    // literals alone. Verified by breaking the map regex AND adding a map-only
    // target — the whole group stayed 8/8 green.
    expect(dispatcherMapKeys().size).toBeGreaterThanOrEqual(13);
    expect(dispatcherLiteralTypes().size).toBeGreaterThanOrEqual(14);
    // And each half must carry a type the other half cannot supply, so neither
    // can be satisfied by the other's output.
    expect(dispatcherMapKeys().has('assembly')).toBe(true);
    expect([...dispatcherLiteralTypes()].filter((t) => !dispatcherMapKeys().has(t)))
      .toEqual(['move']);   // target-level op — a literal with no DISPATCHERS key
    const emitted = emittedEntityTypes();
    expect(emitted.has('deal_memory')).toBe(true);
    expect(emitted.has('job')).toBe(true);
    expect(emitted.size).toBeGreaterThanOrEqual(14);
  });

  test('every emitted entity type has a registry entry, or a stated reason not to', () => {
    // `assembly` was the one that failed this: three emit sites in
    // payload-dispatcher.js (create / update / delete) and no entry at all.
    expect(unhandled(emittedEntityTypes(), new Set(P.types()))).toEqual([]);
  });

  test('the check bites — drop the entry that was missing and it is named', () => {
    const without = new Set(P.types());
    without.delete('assembly');
    expect(unhandled(emittedEntityTypes(), without)).toEqual(['assembly']);
  });

  test('the exclusion list is not a place to hide a real type', () => {
    // A type cannot be BOTH excluded as meta and registered — that means
    // somebody added the entry and left the excuse behind, and the next reader
    // cannot tell which one is the truth.
    const both = Object.keys(META_TYPES).filter((t) => P.types().indexOf(t) !== -1);
    expect(both).toEqual([]);
  });

  test('every exclusion is still emitted — no rotted excuses', () => {
    // If the dispatcher stops emitting one of these, the entry here is dead
    // documentation pointing at a door that no longer exists.
    const emitted = emittedEntityTypes();
    const rotted = Object.keys(META_TYPES).filter((t) => !emitted.has(t));
    expect(rotted).toEqual([]);
  });

  test('every exclusion carries a real reason, not an empty string', () => {
    const unjustified = Object.keys(META_TYPES)
      .filter((t) => !META_TYPES[t] || String(META_TYPES[t]).trim().length < 40);
    expect(unjustified).toEqual([]);
  });

  test('an agent assembly write refreshes the recipe list exactly once', async () => {
    // COUNT, not truthiness. The two failure modes are "zero" (what shipped)
    // and "twice" (what a careless fix produces).
    window.p86Assemblies = { renderList: jest.fn() };

    P.fromTargets([
      { entity_type: 'assembly', entity_id: 11 },
      { entity_type: 'assembly', entity_id: 12 },
      { entity_type: 'assembly', entity_id: 13 }
    ], 'pay_asm');
    await settle();

    expect(window.p86Assemblies.renderList).toHaveBeenCalledTimes(1);
    // NULL PREFIX: renderList keeps whichever host prefix and view filter the
    // visible Assembly Studio tab set. Passing a prefix here would yank the
    // user's Parametric filter off under them.
    //
    // QUIET: renderList blanks its host to "Loading assemblies…" before it
    // fetches, so a data-changed refresh was blanking a list the user was
    // already reading — the exact rule this same pass had just enforced for the
    // Jobs Hub, broken one entry away. The mode lives in renderList; this only
    // asks for it.
    expect(window.p86Assemblies.renderList).toHaveBeenCalledWith(null, { quiet: true });

    delete window.p86Assemblies;
  });

  test('renderList really HAS a quiet mode — asking for one it ignores is worse than not asking', () => {
    // Source check: the registry passing { quiet: true } proves nothing unless
    // the blank is actually behind that flag.
    const asm = codeOnly(SOURCES.find((s) => s.file === 'assemblies.js').src);
    const body = fnBody(asm, 'renderList');
    expect(body).not.toBeNull();
    expect(body).toMatch(/if\s*\(!\(opts\s*&&\s*opts\.quiet\)\)\s*host\.innerHTML\s*=/);
    // Exactly one place can paint the spinner, and it is behind that gate.
    expect({ blanks: (body.match(/Loading assemblies/g) || []).length }).toEqual({ blanks: 1 });
    // And a quiet refresh must not be mistaken for a VIEW SWITCH: keying the
    // filter reset on `opts` being truthy would drop the user's Parametric
    // filter every time a recipe was saved.
    expect(body).toMatch(/hasOwnProperty\.call\(opts,\s*'parametricOnly'\)/);
  });

  test('an assembly write does NOT also drive the Studio cockpit — console.js already does', async () => {
    // js/console.js has its own visibility-gated p86:payload-applied listener
    // for the research inbox + tuning queue. Naming them in the registry too
    // would refresh them twice per applied card.
    window.p86Assemblies = { renderList: jest.fn() };
    window.p86Console = { loadAssemblyStudio: jest.fn() };

    P('assembly', { id: 9 });
    await settle();

    expect(window.p86Console.loadAssemblyStudio).not.toHaveBeenCalled();

    delete window.p86Assemblies;
    delete window.p86Console;
  });
});

// ── the sequencing seam: p86Refresh.now ─────────────────────────────────────
// p86Refresh() coalesces on a timer and returns nothing, so a caller that has
// to hand control back to a callback AFTER the store patch lands could not use
// it — and js/jobs-hub.js's bill editor therefore hand-rolled its own
// store-then-surface pair, which then drifted from the registry and lost the
// p86RepaintJobMoneyTabs fallback entirely. `now` closes that gap so the copy
// can be deleted rather than kept in sync.
describe('p86Refresh.now — the promise-returning seam', () => {
  test('resolves only AFTER the store patch lands, so a caller can sequence on it', async () => {
    const order = [];
    let release;
    window.loadBillsForJob = jest.fn(() => {
      order.push('store-start');
      return new Promise((res) => { release = () => { order.push('store-done'); res(); }; });
    });
    window.renderJobsMain = jest.fn(() => { order.push('surface'); });

    let settled = false;
    const p = P.now('bill', { jobId: 'job_1' }).then(() => { order.push('onSaved'); settled = true; });

    await Promise.resolve();
    expect(order).toEqual(['store-start']);
    expect(settled).toBe(false);          // onSaved has NOT fired

    release();
    await p;

    // The exact ordering the bill editor depends on: the refetch, then the
    // repaint, then the caller's callback. Firing onSaved first is what painted
    // the pre-write numbers and made a saved bill look unsaved.
    expect(order).toEqual(['store-start', 'store-done', 'surface', 'onSaved']);
  });

  test('runs immediately — it does not wait out the coalescing window', async () => {
    window.loadBillsForJob = jest.fn(() => Promise.resolve());
    P.now('bill', { jobId: 'job_1' });
    await Promise.resolve();
    // No jest.advanceTimersByTime: a user pressing Save must not sit through a
    // 200ms debounce before the list they are looking at is refetched.
    expect(window.loadBillsForJob).toHaveBeenCalledWith('job_1', true);
  });

  test('takes the SAME registry path — forced refetch, then the money surfaces', async () => {
    window.appState.currentJobId = 'job_open';
    window.loadBillsForJob = jest.fn(() => Promise.resolve());
    window.renderJobsMain = jest.fn();
    window.p86JobsHubRefresh = jest.fn();
    window.p86JobDetailRefresh = jest.fn(() => false);   // human edit — latch not set
    window.p86RepaintJobMoneyTabs = jest.fn();

    await P.now('bill', { jobId: 'job_open' });

    expect(window.loadBillsForJob).toHaveBeenCalledWith('job_open', true);
    expect(window.renderJobsMain).toHaveBeenCalledTimes(1);
    expect(window.p86JobsHubRefresh).toHaveBeenCalledTimes(1);
    // THE F0 DEFECT: the hand-rolled copy called p86JobDetailRefresh and stopped
    // there. It is latch-gated and returns false for a human edit, so a bill
    // edited from the Bills tab repainted the open job's money tabs ZERO times.
    expect(window.p86RepaintJobMoneyTabs).toHaveBeenCalledTimes(1);
  });

  test('an unknown type is a resolved promise, never a throw and never a hang', async () => {
    await expect(P.now('wormhole', { jobId: 'x' })).resolves.toBeUndefined();
    await expect(P.now(null)).resolves.toBeUndefined();
  });

  test('a rejecting store still resolves — a failed refetch must not strand onSaved', async () => {
    window.loadBillsForJob = jest.fn(() => Promise.reject(new Error('offline')));
    window.renderJobsMain = jest.fn();
    await P.now('bill', { jobId: 'job_1' });
    expect(window.renderJobsMain).toHaveBeenCalled();
  });

  test('it absorbs anything already queued in the window rather than running twice', async () => {
    window.loadBillsForJob = jest.fn(() => Promise.resolve());
    window.renderJobsMain = jest.fn();

    P('bill', { jobId: 'job_a' });          // queued on the timer
    await P.now('bill', { jobId: 'job_b' }); // flushes the bucket, both jobs
    await settle();                          // and the timer must find nothing left

    const jobs = window.loadBillsForJob.mock.calls.map((c) => c[0]).sort();
    expect(jobs).toEqual(['job_a', 'job_b']);
    expect(window.renderJobsMain).toHaveBeenCalledTimes(1);
  });

  test('refreshBillRollup is the registry, not a copy of it', () => {
    // Source check. The runtime tests above prove `now` behaves; this proves the
    // bill editor actually goes through it. A second implementation that merely
    // happens to agree today is what produced F0 in the first place.
    const hub = codeOnly(SOURCES.find((s) => s.file === 'jobs-hub.js').src);
    const body = fnBody(hub, 'refreshBillRollup');
    expect(body).not.toBeNull();
    expect(body).toMatch(/window\.p86Refresh\.now\('bill',\s*\{\s*jobId:\s*jobId\s*\}\)/);
    // And it no longer hand-rolls any of the three halves.
    expect({ loader: (body.match(/loadBillsForJob\s*\(/g) || []).length }).toEqual({ loader: 0 });
    expect({ paint: (body.match(/renderJobsMain\s*\(/g) || []).length }).toEqual({ paint: 0 });
    expect({ detail: (body.match(/p86JobDetailRefresh\s*\(/g) || []).length }).toEqual({ detail: 0 });
  });

  test('every bill mutation still AWAITS the rollup before handing back onSaved', () => {
    // save / setStatus / del / create — all four must chain, not fire-and-forget.
    // submitCreate was the one that did not: it called refreshBillRollup and
    // then onSaved on the next line.
    const hub = codeOnly(SOURCES.find((s) => s.file === 'jobs-hub.js').src);
    // `(?<!function )` so the declaration is not counted as a call site.
    const calls = hub.match(/(?<!function )refreshBillRollup\(/g) || [];
    expect(calls.length).toBe(4);
    // Each one is either returned into a .then chain or has .then( on it.
    const orphaned = hub
      .split('\n')
      .filter((l) => /refreshBillRollup\(/.test(l) && !/function refreshBillRollup\(/.test(l))
      .filter((l) => !/return\s+refreshBillRollup\(/.test(l) && !/refreshBillRollup\([^)]*\)\.then\(/.test(l));
    expect(orphaned).toEqual([]);
  });
});

// ── THE THIRD DIRECTION: client mutation sites → registry ───────────────────
// The two existing guards walk registry → door and door → registry. BOTH are
// blind to the same thing: client code that mutates a known store or drives a
// known loader/painter WITHOUT going through p86Refresh at all. Such a site has
// no registry entry to be wrong about and emits no dispatcher target, so it is
// invisible to every check above.
//
// js/doc-import.js was exactly that. Bulk Document Import creates purchase
// orders, change orders and vendor bills — contract and committed-cost dollars —
// and contained ZERO p86Refresh calls. It hand-concated create responses into
// appData.jobPurchaseOrders / jobChangeOrders, called loadBillsForJob() unforced
// and unawaited (so it could join a GET issued before the write), and finished
// with one bare renderJobsMain(). It went through a sweep whose stated goal was
// "everywhere" untouched, because nothing was looking in this direction.
//
// The allowlist below is NAMED AND JUSTIFIED, per file per symbol, exactly like
// META_TYPES — not a loosened pattern. A pattern that quietly matches the
// legitimate sites would also quietly match the next doc-import.js.
//
// WHAT IT WATCHES, all three derived from source and not from a brief, across
// EVERY directory index.html loads (see SCRIPT_ROOTS above — js/ AND nodegraph/,
// where the "every file in js/" version of this had a whole blind directory):
//   · the five server-backed money mirrors on appData (cross-checked against
//     the boot hydrate in js/app.js), written by assignment — plain, compound
//     (`+=`), or logical (`??=`/`||=`/`&&=`) — by increment at either fixity, by
//     computed key, by in-place array mutation at any depth, by truncating
//     .length, by writing a FIELD (or a field of a field, or a computed key) of
//     an indexed element, by replacing an indexed element outright, through
//     `delete`, through Object.assign's first argument whether that argument is
//     the mirror or `appData` itself, and through `?.` before either a dotted or
//     a computed key; a destructuring bind of one is reported too, as its own
//     symbol, because it is the doorway to a write this scan can no longer
//     follow;
//   · the three load*ForJob money loaders (the whole set — scanned for, not
//     assumed), with an UNFORCED call reported as its own separate finding;
//   · all four repainters in refresh.js's REPAINT_JOB_MONEY_PATHS, in the
//     `window.`-qualified and bare-global spellings alike.
//
// AND WHAT IT DOES NOT — three limits, all of them tested rather than implied.
// Each is stated at the width it actually holds, because the recurring failure
// of this guard has not been its code: it is that every round closed a gap and
// then wrote a sentence one size larger than the fix. Two of the three limits
// below were previously overstated in exactly that way.
//
//   1. It matches TEXT, so it cannot resolve VALUES. TWO classes escape, not
//      one — this used to say "an indirection through a variable defeats it,
//      always", which was false in both directions: nine classes of direct
//      literal write were also escaping (now caught, see the C1 tests), and one
//      whole class of miss is not indirection at all. Class 1 is indirection through a
//      value (an aliased mirror or loader, a runtime-built key). Class 2 is a
//      write through a binding the LANGUAGE creates — `forEach`/`map`/`for…of`
//      hand an element to a name the scanner has never seen. Both are pinned in
//      'the misses are named' below, and that list is not claimed to be
//      complete: it is what is known to escape today.
//   2. Granularity is per FILE per SYMBOL, not per statement. One justification
//      covers every occurrence of that symbol in that file, and two things stop
//      it covering a site nobody read: each entry declares `sites` (the count)
//      and `in` (the innermost NAMED FUNCTION each site sits in, derived from
//      source). The count catches an ADDED site; the count alone did NOT catch a
//      REPLACED one, and the sentence here used to claim it did — disproved by
//      injection and now closed by `in`. What remains open, precisely: a
//      replacement INSIDE THE SAME named function. Resolution is one function,
//      not one statement. The cost is honest and worth naming: renaming a
//      function, or adding a legitimate site, fails the build until someone
//      re-reads the justification — which is the point.
//   3. It cannot check that a justification is TRUE. It checks that the author
//      was looking at the right file — every reason must name at least one code
//      identifier that literally occurs in the file it excuses. That replaced a
//      `length >= 60` check, which a verbose shrug satisfied. This limit is the
//      one that has never been overstated, and it is the one that predicted the
//      four false reasons this round had to rewrite.
describe('mutation site → registry: nothing patches a money store behind the registry', () => {
  // The read-caches the registry declares as its own `store` half. Cross-checked
  // against js/app.js, which is where the boot hydrate seeds them: these five are
  // the SERVER-backed per-job money mirrors, and they are exactly the four the
  // registry's jobIdsFor() reads plus the subs directory.
  //
  // DELIBERATELY NOT LISTED, and this is a distinction the guard would be wrong
  // to blur: appData.purchaseOrders / changeOrders / invoices / subs. Those are
  // the LEGACY localStorage blobs (app.js seeds them from
  // safeLoadJSON('p86-jobs-purchaseorders') and friends) — the dead-store bug
  // class, not tables. No registry entry owns them, no dispatcher target names
  // them, and folding them in here would light up a dozen legacy filter/splice
  // sites that have nothing to do with the refresh heartbeat, which is how an
  // allowlist becomes noise nobody reads.
  const STORE_MIRRORS = ['jobPurchaseOrders', 'jobChangeOrders', 'jobVendorBills', 'arInvoices', 'subsDirectory'];
  // The money loaders the registry drives as its `store` half. Calling one
  // directly is doing by hand what the registry exists to do in one place, in
  // the right order.
  //
  // These three are the whole set, checked by scanning js/ for load*ForJob.
  // The one other match — loadPOsForJob in js/jobs-hub.js — is a LOCAL closure
  // inside the create-bill overlay that fills a <select> from the API and
  // touches no store, so it is not a sibling and is not listed. (Noted because
  // a future "just widen it to load\w+ForJob" would sweep it in and teach the
  // next reader that the allowlist is full of things that don't matter.)
  const MONEY_LOADERS = ['loadBillsForJob', 'loadPurchaseOrdersForJob', 'loadChangeOrdersForJob'];
  // The repainters the registry owns — REPAINT_JOB_MONEY_PATHS in js/refresh.js,
  // verbatim. Only renderJobsMain used to be checked here, which left three of
  // the four unwatched; p86JobsHubRefresh had its own single-name scan above and
  // p86JobDetailRefresh / p86RepaintJobMoneyTabs had nothing at all.
  const REPAINTERS = ['renderJobsMain', 'p86JobsHubRefresh', 'p86JobDetailRefresh', 'p86RepaintJobMoneyTabs'];
  const CALLABLES = MONEY_LOADERS.concat(REPAINTERS);

  // A reference to a mirror, in BOTH spellings: `appData.jobVendorBills` and the
  // computed `appData['jobVendorBills']`. The computed form is the obvious way
  // to walk past a dot-only pattern, so it is matched rather than left as a
  // documented hole.
  const MIRROR_ALT = STORE_MIRRORS.join('|');
  // `?.` is tolerated on BOTH hops — `window.appData?.arInvoices.push(r)` was an
  // undocumented miss, and optional chaining is the one syntax a defensive
  // author reaches for without thinking of it as evasion.
  //
  // The `\.?` before the computed form is C1's smallest fix: the `\??` tolerance
  // sat between `appData` and a DOTTED key but not before a COMPUTED one, so
  // `appData?.["arInvoices"]` — optional chaining and a computed key in the same
  // expression, each of which was separately caught — walked past both.
  const MIRROR_REF = "(?:^|[^\\w.$])(?:window\\.)?appData\\s*\\??\\s*(?:\\.\\s*(" + MIRROR_ALT +
                     ")|\\.?\\s*\\[\\s*['\"](" + MIRROR_ALT + ")['\"]\\s*\\])";
  // In-place array mutation. doc-import.js used `= (…||[]).concat(rec)`, so the
  // `=` half is what actually shipped — but `.push(rec)` is the same defect one
  // keystroke away, and a guard that only knows the shape of the bug it already
  // found is a guard for last week.
  const MUTATORS = 'push|pop|shift|unshift|splice|sort|reverse|fill|copyWithin';
  // ONE MEMBER HOP, dot or computed, `?.` tolerated. Chained below, because the
  // number of hops between the mirror and the thing being assigned is not a
  // property the guard should have an opinion about.
  const ACCESS = "(?:\\s*\\??\\s*\\.\\s*[\\w$]+|\\s*\\??\\s*\\[[^\\]\\n]*\\])";
  // EVERY assignment operator, not just `=`. `=(?!=)` and the compound forms
  // each exclude `==`/`===` by construction; `??=`, `||=` and `&&=` are listed
  // ahead of the single-char class so the longest form wins.
  const ASSIGN_OP = "(?:\\*\\*=|<<=|>>>=|>>=|\\?\\?=|\\|\\|=|&&=|[+\\-*/%&|^]=(?!=)|=(?!=))";
  // C1. The old tail hard-required `\.\s*[\w$]+\s*=(?!=)` after a single `[…]`:
  // ONE dot hop, ONE plain `=`. So NINE CLASSES of direct, literal,
  // indirection-free money write walked straight past it — `+=`, `++`, `['amount'] =`, a
  // SECOND dot hop (`[0].data.buildingAllocations =`, the Site Plan's CO
  // allocation write, which is what the round that added this tail was about)
  // and a bare `[0] =` replacing a whole money row. It also required a plain `=`
  // on the mirror itself, so `??=` / `||=` / `&&=` were missed a level up.
  //
  // Three alternatives now, and the hop count is a `*`/`+` rather than a
  // literal: assign-or-compound on the mirror; a mutator method at the end of a
  // chain of hops; and any assignment or increment after one or more hops.
  const WRITE_RE = new RegExp(
    MIRROR_REF + "(?:" +
      "\\s*\\??\\s*" + ASSIGN_OP +
      "|" + ACCESS + "*\\s*\\??\\s*\\.\\s*(?:" + MUTATORS + ")\\s*\\(" +
      "|" + ACCESS + "+\\s*(?:" + ASSIGN_OP + "|\\+\\+|--)" +
    ")", 'gm');
  // PREFIX increment, which has no tail to match: `--appData.arInvoices[0].qty`.
  // Its own pattern because the token sits BEFORE the mirror, and because a
  // trailing-nothing alternative in WRITE_RE would match every read.
  const INCR_RE = new RegExp("(?:\\+\\+|--)\\s*(?:window\\.)?appData\\s*\\??\\s*(?:\\.\\s*(" +
                             MIRROR_ALT + ")|\\.?\\s*\\[\\s*['\"](" + MIRROR_ALT + ")['\"]\\s*\\])", 'gm');
  // Removing the mirror wholesale is a write, and the least recoverable one:
  // every reader then sees undefined rather than a stale number.
  const DELETE_RE = new RegExp("delete\\s+(?:window\\.)?appData\\s*\\??\\s*(?:\\.\\s*(" + MIRROR_ALT +
                               ")|\\.?\\s*\\[\\s*['\"](" + MIRROR_ALT + ")['\"]\\s*\\])", 'gm');
  // Object.assign's FIRST argument is a mutation of that object. This is the
  // one write shape that reads like a read.
  const ASSIGN_RE = new RegExp("Object\\.assign\\s*\\(\\s*(?:window\\.)?appData\\s*\\??\\s*(?:\\.\\s*(" +
                               MIRROR_ALT + ")|\\.?\\s*\\[\\s*['\"](" + MIRROR_ALT + ")['\"]\\s*\\])", 'gm');
  // C1. ASSIGN_RE requires `appData.<mirror>` as argument 1 — so `appData`
  // ITSELF as argument 1 was a hole, and `Object.assign(window.appData, {
  // arInvoices: rows })` replaces a money mirror wholesale while naming it only
  // in argument 2. Matched here as a ROOT target; countsIn then reads the real
  // argument list with argsAt (brace-balanced, so a nested object or a
  // multi-line literal is handled) and reports every mirror named in it.
  const ASSIGN_ROOT_RE = /Object\.assign\s*\(\s*(?:window\.)?appData\s*(?=[,)])/gm;
  // A destructuring bind is not itself a write — it is the ALIAS that makes the
  // next line's write invisible (limit 1 above). Reported under its own symbol
  // so the justification has to say which it is: "I only read it" or "I write
  // through the alias". Nothing in the tree destructures a mirror today.
  const DESTRUCT_RE = new RegExp("\\{[^{}]*\\b(" + MIRROR_ALT +
                                 ")\\b[^{}]*\\}\\s*=\\s*(?:window\\.)?appData\\b", 'gm');
  const CALL_RE = new RegExp('(?:^|[^\\w.$])(?:window\\.)?(' + CALLABLES.join('|') + ')\\s*\\(', 'gm');

  // The argument list of the call whose `(` is at `openIdx`, brace-balanced.
  function argsAt(code, openIdx) {
    let depth = 0;
    for (let i = openIdx; i < code.length; i++) {
      const c = code[i];
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') { if (--depth === 0) return code.slice(openIdx + 1, i); }
    }
    return null;
  }
  function topLevelCommas(args) {
    let depth = 0, n = 0;
    for (const c of args) {
      if ('([{'.indexOf(c) !== -1) depth++;
      else if (')]}'.indexOf(c) !== -1) depth--;
      else if (c === ',' && depth === 0) n++;
    }
    return n;
  }

  // Every symbol a file touches behind the registry's back. A money loader called
  // with a SINGLE argument reports twice — once as a direct call, and once as
  // `<loader> (no force)`, because omitting `force` is a defect in its own right:
  // every load*ForJob is in-flight deduped per job, so an unforced call issued
  // after a write JOINS the GET that was issued before it and resolves with
  // pre-write rows. That is the exact trap refresh.js's loadAll() passes `true`
  // to avoid, and it is what doc-import.js did. Two symbols, two justifications:
  // "I own this loader" and "I meant to share the in-flight GET" are different
  // claims and should have to be made separately.
  // THE INNERMOST NAMED FUNCTION containing `idx` — or the literal string
  // `<top-level>` when none does, which is an answer rather than an absence:
  // four sites in js/jobs.js are function DEFINITIONS, whose own headers sit
  // outside their bodies, and top-level is the correct fingerprint for them.
  //
  // Both spellings this tree uses: `function name(` and `name = function (` /
  // `window.name = function (` — the latter is what js/jobs.js's
  // hydrateBillsStore is, and without it that site fingerprinted as top-level
  // when a real name was available.
  //
  // Brace-balanced over COMMENT-STRIPPED source, so its accuracy limit is a
  // brace inside a STRING literal. That direction produces a WRONG NAME, which
  // fails the build as a false alarm — never a silent miss. Corroborated against
  // four independently-established facts (admin.js:267 loadUsersCache,
  // app.js:243/2129/3109 initializeApp/switchTab/fanOutRenderers,
  // engine.js:231-232 createDataEntry, ui.js ensureCOsThenRepaint).
  const TOP = '<top-level>';
  function enclosingFn(code, idx) {
    const re = /function\s+([\w$]+)\s*\(|(?:window\s*\.\s*)?([\w$]+)\s*=\s*function\s*\(/g;
    let m, best = null, bestOpen = -1;
    while ((m = re.exec(code))) {
      if (m.index > idx) break;
      const open = code.indexOf('{', m.index + m[0].length);
      if (open === -1 || open >= idx) continue;
      let depth = 0, end = -1;
      for (let i = open; i < code.length; i++) {
        if (code[i] === '{') depth++;
        else if (code[i] === '}' && --depth === 0) { end = i; break; }
      }
      // Innermost = the latest-opening body that still contains idx.
      if (end > idx && open > bestOpen) { best = m[1] || m[2]; bestOpen = open; }
    }
    return best || TOP;
  }

  // symbol -> [enclosing fn per site]. The COUNT is the array length; the NAMES
  // are what stop a replacement inheriting an excuse (see limit 2 in the header).
  function sitesIn(src) {
    const code = codeOnly(src);
    const hits = Object.create(null);
    const bump = (k, i) => { (hits[k] = hits[k] || []).push(enclosingFn(code, i)); };
    let m;
    [WRITE_RE, INCR_RE, DELETE_RE, ASSIGN_RE].forEach((re) => {
      re.lastIndex = 0; while ((m = re.exec(code))) bump(m[1] || m[2], m.index);
    });
    // `Object.assign(appData, …)` — the mirror is named in argument 2, so the
    // real argument list is read rather than pattern-matched.
    ASSIGN_ROOT_RE.lastIndex = 0;
    while ((m = ASSIGN_ROOT_RE.exec(code))) {
      const args = argsAt(code, code.indexOf('(', m.index));
      if (args === null) continue;
      const idx = m.index;
      STORE_MIRRORS.forEach((k) => {
        if (new RegExp('\\b' + k + '\\b').test(args)) bump(k, idx);
      });
    }
    DESTRUCT_RE.lastIndex = 0;
    while ((m = DESTRUCT_RE.exec(code))) bump(m[1] + ' (destructured)', m.index);
    CALL_RE.lastIndex = 0;
    while ((m = CALL_RE.exec(code))) {
      const sym = m[1];
      bump(sym, m.index);
      if (MONEY_LOADERS.indexOf(sym) === -1) continue;
      const open = code.indexOf('(', m.index + m[0].length - 1);
      const args = argsAt(code, open);
      // No args at all is a no-op call, not an unforced refetch.
      if (args !== null && args.trim() !== '' && topLevelCommas(args) === 0) bump(sym + ' (no force)', m.index);
    }
    Object.keys(hits).forEach((k) => hits[k].sort());
    return hits;
  }
  function countsIn(src) {
    const sites = sitesIn(src);
    const out = Object.create(null);
    Object.keys(sites).forEach((k) => { out[k] = sites[k].length; });
    return out;
  }
  function bypassesIn(src) { return Object.keys(countsIn(src)).sort(); }

  // Code identifiers a justification cites, minus the symbol it is excusing.
  // Shape-based, so English prose contributes nothing: a camelCase hump, an
  // underscore, or a `$`. The " (no force)" / " (destructured)" suffixes name
  // the same symbol, so they are stripped before the exclusion.
  function citations(why, sym) {
    const self = String(sym || '').replace(/ \(.*\)$/, '');
    return (String(why).match(/[A-Za-z_$][A-Za-z0-9_$]{4,}/g) || [])
      .filter((t) => /[a-z][A-Z]/.test(t) || t.indexOf('_') !== -1 || t.indexOf('$') !== -1)
      .filter((t) => t !== self);
  }

  // file → symbol → { sites, in, why }. Every entry is a claim someone had to
  // write down; adding a file here is meant to be uncomfortable.
  //
  // `sites` is HOW MANY occurrences the reason was written against and `in` is
  // WHERE each one was — the innermost named function containing it. Both are
  // derived from source and compared, so neither is a sentence anyone has to be
  // trusted about: `sites` fails on an added or removed site, `in` fails on a
  // moved or replaced one. See limit 2 in the header for what the pair still
  // does not close (a replacement inside the same named function).
  //
  // `why` is the half no check can verify. Line numbers inside a `why` are a
  // reading aid, not an assertion — they are not derived, so treat a drift
  // failure's derived `in` list as the record and the numbers as stale until
  // re-read.
  const ALLOWED = {
    'app.js': {
      // C3.3. The old reason said "loadFromLocalStorage seeds this mirror from
      // the cache and hydrateFromServerJobs replaces it from the server". The
      // first half is true; the second is not. hydrateFromServerJobs (:2599+)
      // writes the LEGACY appData.purchaseOrders = [] and touches jobChangeOrders
      // — it never writes jobPurchaseOrders. Site 2 is :2984, in the boot
      // Promise.all().then.
      jobPurchaseOrders: { sites: 2, in: ['_loadDataFromServer', 'loadFromLocalStorage'], why: 'Two boot seeds of the read-cache the registry later patches, and neither is a mutation behind it. loadFromLocalStorage (:2528) primes it from the p86-jobs-jobpurchaseorders cache so ACCRUED paints its true value on the first synchronous render; _loadDataFromServer (:2984) then replaces it wholesale from purchaseOrders.listAll in the boot Promise.all. hydrateFromServerJobs is deliberately NOT named here: it writes the legacy appData.purchaseOrders and never this mirror.' },
      jobChangeOrders:   { sites: 3, in: ['_loadDataFromServer', 'hydrateFromServerJobs', 'loadFromLocalStorage'], why: 'The same boot seeding, across three sites and all three of them real: loadFromLocalStorage (:2533) primes from cache; hydrateFromServerJobs (:2609) preserves-or-initialises it while fanning the JSONB blob back out into the flat arrays; and _loadDataFromServer (:2985) installs the changeOrders.listAll rows. This is the read-cache every other site must go through the registry to amend.' },
      // C3.2. The old reason said "loadFromLocalStorage hands the bills list to
      // appData wholesale". loadFromLocalStorage (:2518-2544) never writes
      // jobVendorBills at all — the cache has no bills key.
      jobVendorBills:    { sites: 1, in: ['_loadDataFromServer'], why: 'One site, :2999, and it is a SERVER snapshot rather than a cache seed: the `else` arm of the boot Promise.all().then, taken only when window.hydrateBillsStore is absent, installing bills.listAll plus the _billsAllLoaded trust flag. When jobs.js is loaded that arm never runs and hydrateBillsStore owns the merge instead. loadFromLocalStorage is deliberately NOT named here — it has no bills key to hand over.' },
      arInvoices:        { sites: 1, in: ['_loadDataFromServer'], why: 'One site, :2986, in the boot Promise.all().then: the AR rows from invoices.list are installed so getJobWIP computes real Invoiced/Unbilled figures instead of the stale invoicedToDate scalar. A server seed, not a cache one; the registry `invoice` entry patches it afterwards via p86InvoicesSyncStore.' },
      subsDirectory:     { sites: 1, in: ['_loadDataFromServer'], why: 'One site, :2982, in the same boot Promise.all().then — the subcontractor directory arriving with knownTrades from one subs.list call. js/subs.js then owns the page and refetches it on open.' },
      // C3.4. `sites: 3` with a reason that described exactly one of them (the
      // fan-out). Three sites, three sentences.
      renderJobsMain:    { sites: 3, in: ['fanOutRenderers', 'initializeApp', 'switchTab'], why: 'Three sites, none of them a post-money-write repaint. :243 is the COLD BOOT paint in initializeApp — it runs after loadData() and before any server hydrate resolves, so there is no entity row yet to name a registry type for. :2129 is NAVIGATION in switchTab: returning to the Jobs tab forces the main list back over a job detail that would otherwise stay layered on top and steal clicks. :3109 is the post-hydrate fan-out (fanOutRenderers, via the isolated fanOut wrapper) — when a full appData reload lands every list repaints from here, and that IS the `job`/`estimate` registry entry running, not a bypass of it.' },
      p86JobDetailRefresh: { sites: 1, in: ['fanOutRenderers'], why: 'The post-hydrate fan-out only (fanOutRenderers, :3122). The open job page must repaint AFTER the appData load installs its objects, not off an event that races it — and the call is latch-gated, so it no-ops unless an agent write is actually pending. Firing a registry type here would re-enter the hydrate that is running.' }
    },
    'jobs.js': {
      loadBillsForJob:          { sites: 2, in: ['<top-level>', 'renderJobPurchaseOrdersInto'], why: 'DEFINES it (the body that owns _billFetchInflight and is what the registry `bill` store resolves off window), plus one internal read in renderJobPurchaseOrdersInto — a money tab opening, which legitimately shares the in-flight GET.' },
      loadPurchaseOrdersForJob: { sites: 2, in: ['<top-level>', 'renderJobPurchaseOrdersInto'], why: 'DEFINES it — the registry `po` store resolves this very function off window — plus the paired read in renderJobPurchaseOrdersInto that fills the accrued tile on first paint.' },
      loadChangeOrdersForJob:   { sites: 2, in: ['<top-level>', 'renderJobChangeOrdersInto'], why: 'DEFINES it — the registry `co` store resolves this very function off window; renderJobChangeOrdersInto is the other, a first-paint read.' },
      'loadBillsForJob (no force)':          { sites: 1, in: ['renderJobPurchaseOrdersInto'], why: 'The money-tab OPEN path: the Promise.all in renderJobPurchaseOrdersInto that runs before paintJobPurchaseOrdersInto. Opening a tab is navigation, not a write, so joining an in-flight GET is the point — forcing here would issue a duplicate fetch on every tab switch.' },
      'loadPurchaseOrdersForJob (no force)': { sites: 1, in: ['renderJobPurchaseOrdersInto'], why: 'Same money-tab open: paired with loadBillsForJob in one Promise.all so the tab paints once both reads land. No write preceded it, so there is no pre-write GET to be fooled by.' },
      'loadChangeOrdersForJob (no force)':   { sites: 1, in: ['renderJobChangeOrdersInto'], why: 'renderJobChangeOrdersInto: a view transition reading rows it does not yet have, deliberately sharing whatever fetch is already in flight for that job.' },
      renderJobsMain:           { sites: 3, in: ['<top-level>', 'backToJobsMain', 'saveJob'], why: 'DEFINES it (:17, which is why one fingerprint is top-level rather than a function name), and re-paints the jobs list on its own view transitions — backToJobsMain and the saveJob create path — which are navigation and a local push, not server money rows.' },
      jobPurchaseOrders:        { sites: 2, in: ['loadPurchaseOrdersForJob', 'loadPurchaseOrdersForJob'], why: 'The loader body: loadPurchaseOrdersForJob is where the mirror is legitimately replaced for a job, and it is what the registry calls to do so.' },
      jobChangeOrders:          { sites: 2, in: ['loadChangeOrdersForJob', 'loadChangeOrdersForJob'], why: 'The loader body: loadChangeOrdersForJob writes the mirror it exists to refresh.' },
      jobVendorBills:           { sites: 3, in: ['hydrateBillsStore', 'loadBillsForJob', 'loadBillsForJob'], why: 'The loader body: loadBillsForJob writes the mirror it exists to refresh, plus hydrateBillsStore — the whole-org boot snapshot, which keeps whatever a per-job load already pulled and merges the rest in behind the _billsAllLoaded trust flag.' }
    },
    'invoices.js': {
      // The fingerprint reads _syncJobsWIP, not p86InvoicesSyncStore: they are
      // the SAME function (`window.p86InvoicesSyncStore = _syncJobsWIP`, :332),
      // named once for the module and once for the registry seam.
      arInvoices: { sites: 1, in: ['_syncJobsWIP'], why: 'This IS the registry `invoice` store half — _syncJobsWIP, published as window.p86InvoicesSyncStore, refetches /invoices and patches appData.arInvoices and nothing else. The registry names that alias in the entry`s paths, and the repaint deliberately stayed in js/refresh.js so one edit does not paint the jobs table twice.' }
    },
    'subs.js': {
      subsDirectory: { sites: 1, in: ['refresh'], why: 'The module`s own refresh() replaces the directory from p86Api.subs.list and then calls renderDirectory (and loadViews behind _viewsLoaded) — it owns this page and refetches it on open. `sub` was deliberately REMOVED from the registry because no door emits it, so there is no entry to route through.' }
    },
    'nodegraph/engine.js': {
      // Found the moment the scan stopped being "every file in js/".
      //
      // THE ONLY ENTRY WHOSE REASON REACHED FOR A CALLER rather than the
      // function its site is in. It said `addNode('sub')`; both writes are at
      // :231-232 inside createDataEntry (:193-277), and addNode (:278) reaches
      // them by calling it. Causally accurate, one hop out — which is precisely
      // the kind of near-miss the `in` fingerprint now settles, because the
      // fingerprint is derived and the sentence is not. Both are named below.
      subsDirectory: { sites: 2, in: ['createDataEntry', 'createDataEntry'], why: 'createDataEntry(`sub`) — reached from addNode when a sub NODE is dropped — initialises appData.subsDirectory if absent, pushes the row, and fires agxApi.subs.create to persist it. Same reason as js/subs.js: `sub` is deliberately absent from the registry because no dispatcher door emits it, so there is no type to route through; the Subs page refetches the directory on open and the node itself renders from the entry just pushed.' }
    },
    'nodegraph/ui.js': {
      // Also only visible once nodegraph/ was scanned. Identical in shape to the
      // allowlisted jobs.js section reads — and it would have failed the build
      // in js/ while passing silently here, which is the whole point of B1.
      loadChangeOrdersForJob:            { sites: 1, in: ['ensureCOsThenRepaint'], why: 'ensureCOsThenRepaint: change orders load per job on demand and the Site Plan inspector paints before that resolves, so the Contract-allocation card rendered empty on first open. Guarded by `if(count()) return;` — a FIRST-PAINT READ, never a post-write refresh; the write path in openCoAllocEditor goes through p86Refresh.now.' },
      'loadChangeOrdersForJob (no force)': { sites: 1, in: ['ensureCOsThenRepaint'], why: 'Same ensureCOsThenRepaint call, and unforced ON PURPOSE: loadChangeOrdersForJob dedups in flight, and this is a view transition sharing whatever fetch is already running for the job. No write precedes it, so there is no pre-write GET to be fooled by.' },
      loadPurchaseOrdersForJob:            { sites: 1, in: ['ensurePOs'], why: 'ensurePOs, inside openCoAllocEditor: the change-order editor now shows which PURCHASE ORDER the CO`s cost draws against, and appData.jobPurchaseOrders loads per job on demand. Without this read every draw renders "that purchase order is not on this job" on first open — a WRONG state shown confidently, which is the one thing a cost-source badge must never do. Latched by `_posLoaded` and guarded by `jobPOs.length>0`, so it fires at most once per open. A FIRST-PAINT READ; the write path in save() goes through p86Refresh.now, exactly as the allocation write beside it does.' },
      'loadPurchaseOrdersForJob (no force)': { sites: 1, in: ['ensurePOs'], why: 'The same ensurePOs call, unforced for the same reason its change-order sibling above is: loadPurchaseOrdersForJob dedups in flight, opening a modal is a view transition rather than a write, and forcing would issue a duplicate GET every time the CO editor is opened. Nothing was written before it, so there is no pre-write GET for a shared fetch to return stale.' }
    },
    'purchase-order-editor.js': {
      // C3.1. The previous reason claimed FOUR callers and described the last
      // commit's new one as post-resolve. There are FIVE, and the fifth (:156,
      // in close()) fires BEFORE its DELETEs resolve. Whether that optimistic
      // ordering is itself a defect was checked rather than assumed — see the
      // `close() syncs optimistically` test below, which pins each fact the
      // answer rests on rather than asserting the conclusion.
      jobVendorBills: { sites: 1, in: ['syncBillsToStore'], why: 'syncBillsToStore is the single write, reached from FIVE callers, and not one of them is a surface that needs the registry. Three are POST-RESOLVE, patching this PO`s rows from the server`s own response: after bills.create (:569), after bills.remove resolves in the row delete button (:616), and loadBills (:665), a read mirror of bills.listAll. Two are OPTIMISTIC and say so: updateBillCell (:632) is a keystroke echo ahead of the debounced PUT, and close() (:156) drops never-filled-in blank rows from the mirror while their bills.remove DELETEs are still in flight. The registry `bill` entry differs from the `po` entry this file DOES fire only in its store half; the surface half is literally the same repaintJobMoney, so every bill surface (the Bills hub list, which p86JobsHubRefresh refetches from the server, and the job money tabs) is repainted either way.' }
    },
    'admin.js': {
      renderJobsMain: { sites: 1, in: ['loadUsersCache'], why: 'loadUsersCache repaints after the USER-NAME cache lands, not after a money write. No entity row changed, so there is no registry type to fire and firing one would refetch money for nothing.' }
    },
    'job-costs-import.js': {
      renderJobsMain: { sites: 1, in: ['commitQBCostsImport'], why: 'commitQBCostsImport patches appData.qbCostLines — a store with no registry entry and no dispatcher door — and repaints the list that reads it. Wiring it would mean adding a `qb_cost` type nothing can emit.' }
    },
    'estimate-editor.js': {
      renderJobsMain: { sites: 1, in: ['syncEstimateToJob'], why: 'syncEstimateToJob mirrors contract + estimated cost onto the local job and saves. The registry `job` entry is a FULL appData hydrate, which here would race the saveData it just issued and re-seed from localStorage; the narrow repaint is deliberate.' }
    }
  };

  test('every client bypass of the refresh registry is named and justified', () => {
    const unjustified = [];
    SOURCES.filter((s) => s.file !== 'refresh.js').forEach((s) => {
      bypassesIn(s.src).forEach((sym) => {
        if (!ALLOWED[s.file] || !ALLOWED[s.file][sym]) unjustified.push(s.file + ' → ' + sym);
      });
    });
    // js/doc-import.js was this list, four entries long, on a money surface.
    // nodegraph/engine.js and nodegraph/ui.js joined it the moment the scan
    // stopped meaning "js/" when it said "client code".
    expect(unjustified.sort()).toEqual([]);
  });

  test('the allowlist is not a graveyard — every entry is still a real site', () => {
    // An excuse for a call that no longer exists is dead documentation, and it
    // is how an allowlist turns into a place to hide the next one.
    const rotted = [];
    Object.keys(ALLOWED).forEach((file) => {
      const s = SOURCES.find((x) => x.file === file);
      if (!s) { rotted.push(file + ' (no such file)'); return; }
      const live = bypassesIn(s.src);
      Object.keys(ALLOWED[file]).forEach((sym) => {
        if (live.indexOf(sym) === -1) rotted.push(file + ' → ' + sym);
      });
    });
    expect(rotted.sort()).toEqual([]);
  });

  test('an excuse covers the sites it was WRITTEN against, not any number of them', () => {
    // THE GRANULARITY LIMIT, made into a check. Per-file-per-symbol means one
    // reason covers every occurrence — so once `admin.js -> renderJobsMain` was
    // excused for its user-name cache repaint, a second, genuinely bad
    // post-money-write renderJobsMain() anywhere in admin.js was permanently
    // invisible. Declaring the COUNT makes a NEW site fail: the number moves.
    const drift = [];
    Object.keys(ALLOWED).forEach((file) => {
      const s = SOURCES.find((x) => x.file === file);
      if (!s) return;                      // the graveyard test owns that case
      const live = countsIn(s.src);
      Object.keys(ALLOWED[file]).forEach((sym) => {
        const want = ALLOWED[file][sym].sites;
        const got = live[sym] || 0;
        if (want !== got) drift.push(file + ' → ' + sym + ': declared ' + want + ', found ' + got);
      });
    });
    expect(drift.sort()).toEqual([]);
  });

  test('`sites` and `in` cannot disagree — the count is the length of the list', () => {
    // Two declarations of the same number is two things that can rot apart.
    // They are checked against each other so neither can be quietly wrong.
    const mismatched = [];
    Object.keys(ALLOWED).forEach((file) => {
      Object.keys(ALLOWED[file]).forEach((sym) => {
        const e = ALLOWED[file][sym];
        if (!Array.isArray(e.in)) { mismatched.push(file + ' → ' + sym + ': no `in` list'); return; }
        if (e.in.length !== e.sites) mismatched.push(file + ' → ' + sym + ': sites ' + e.sites + ', in[] ' + e.in.length);
      });
    });
    expect(mismatched.sort()).toEqual([]);
  });

  test('an excuse covers the sites it was written against, not a REPLACEMENT of them', () => {
    // C2. The count alone closes the ADDITIVE case and nothing else, and the
    // sentence above it used to claim the class: "a NEW site cannot inherit an
    // old site's excuse". Disproved by injection — remove the excused
    // renderJobsMain() from admin.js's loadUsersCache and add a genuinely bad
    // one (a post-bills.create repaint with no store patch and no p86Refresh)
    // and the count is still 1, still declared 1, still green.
    //
    // So each site now also declares the innermost NAMED FUNCTION it sits in,
    // and that is derived from source rather than trusted. A replacement lands
    // in a different function, the fingerprint moves, and this fails printing
    // both lists. Chosen over a LINE-NUMBER fingerprint deliberately: line
    // numbers move on every unrelated edit above a site, in every allowlisted
    // file, which trains people to bump the number without re-reading the reason
    // — the exact way an allowlist becomes noise. (A count, not a claim: ten
    // files carry entries today, and a line-number scheme would put a
    // maintenance burden on all of them for a gap a function name already
    // closes.)
    //
    // WHAT IT STILL DOES NOT CLOSE, precisely: a replacement INSIDE THE SAME
    // named function. Swap admin.js's repaint for a bad one still inside
    // loadUsersCache and the fingerprint is unchanged. Resolution is one named
    // function, not one statement — narrower than the count-only gap it
    // replaces, and not zero.
    const drift = [];
    Object.keys(ALLOWED).forEach((file) => {
      const s = SOURCES.find((x) => x.file === file);
      if (!s) return;
      const live = sitesIn(s.src);
      Object.keys(ALLOWED[file]).forEach((sym) => {
        const want = (ALLOWED[file][sym].in || []).slice().sort();
        const got = (live[sym] || []).slice().sort();
        if (want.join(',') !== got.join(',')) {
          drift.push(file + ' → ' + sym + ': declared in [' + want.join(', ') + '], found in [' + got.join(', ') + ']');
        }
      });
    });
    expect(drift.sort()).toEqual([]);
  });

  test('...and THAT check bites — the replacement admin.js injection goes red', () => {
    // The acceptance test for C2, run as an injection exactly like every other
    // shape in this suite: it must be RED under the new check and GREEN under
    // the count-only one, or the fingerprint bought nothing.
    const admin = SOURCES.find((s) => s.file === 'admin.js').src;
    const EXCUSED = "if (typeof renderJobsMain === 'function') renderJobsMain();";
    expect(admin.indexOf(EXCUSED)).toBeGreaterThan(-1);   // anchor
    const replaced = admin.replace(EXCUSED, '') +
      '\nfunction saveBillThing(){ p86Api.bills.create(j, b).then(function(){ renderJobsMain(); }); }\n';

    // The count-only check cannot see it: one site before, one site after.
    expect(countsIn(admin).renderJobsMain).toBe(1);
    expect(countsIn(replaced).renderJobsMain).toBe(1);
    // The fingerprint can.
    expect(sitesIn(admin).renderJobsMain).toEqual(['loadUsersCache']);
    expect(sitesIn(replaced).renderJobsMain).toEqual(['saveBillThing']);

    // And the residual gap is real, so it is asserted rather than described:
    // a bad repaint added INSIDE the excused function is still invisible.
    const sameFn = admin.replace(EXCUSED, EXCUSED + ' p86Api.bills.create(j, b);');
    expect(sitesIn(sameFn).renderJobsMain).toEqual(['loadUsersCache']);
  });

  test('the fingerprint resolves the INNERMOST named function, in both spellings', () => {
    // Guards the guard. `enclosingFn` is what the check above rests on, so its
    // three behaviours are pinned: nesting, `name = function (`, and top-level.
    expect(sitesIn('function outer(){ function inner(){ renderJobsMain(); } }').renderJobsMain)
      .toEqual(['inner']);
    // The spelling js/jobs.js's hydrateBillsStore uses — without this it
    // fingerprinted as top-level.
    expect(sitesIn('window.hydrateBillsStore = function (b) { appData.jobVendorBills = b; };').jobVendorBills)
      .toEqual(['hydrateBillsStore']);
    expect(sitesIn('var f = function () { appData.arInvoices = r; };').arInvoices).toEqual(['f']);
    // A site in no named function at all is labelled, not dropped.
    expect(sitesIn('appData.arInvoices = rows;').arInvoices).toEqual([TOP]);
    // A function DEFINITION's own header sits outside its body, so the three
    // loader definitions in js/jobs.js legitimately fingerprint as top-level.
    expect(sitesIn('function loadBillsForJob(id, force){ var x = 1; }').loadBillsForJob).toEqual([TOP]);
    // A sibling function that CLOSED before the site must not be picked up.
    expect(sitesIn('function a(){ var x = 1; }\nfunction b(){ renderJobsMain(); }').renderJobsMain)
      .toEqual(['b']);
    // An anonymous callback inside a named function reports the named one —
    // the coarseness the check above discloses, asserted so it stays known.
    expect(sitesIn('function outer(){ p.then(function(){ renderJobsMain(); }); }').renderJobsMain)
      .toEqual(['outer']);
  });

  test('every justification NAMES something in the file it excuses', () => {
    // Replaces `length >= 60`, which any verbose shrug satisfied — "this is
    // fine for reasons that are complicated and were discussed elsewhere at
    // some length" is 87 characters and says nothing.
    //
    // The rule a shrug cannot pad its way past: a reason must cite at least one
    // CODE IDENTIFIER that literally occurs in the file it excuses. Identifiers
    // are picked out by shape — a camelCase hump, an underscore or a `$` — so
    // ordinary English ("refresh", "registry", "hydrate") does not count, and
    // the author has to have had the actual source open.
    //
    // THE ALLOWLISTED SYMBOL ITSELF DOES NOT COUNT. Restating the name of the
    // thing being excused is free and proves nothing; the citation has to be
    // the code AROUND it — the function the site sits in, the flag it is gated
    // on, the sibling it is paired with.
    //
    // WHAT IT STILL CANNOT DO, said plainly: it cannot check the claim is TRUE.
    // Naming renderJobDetail does not prove the sentence about it is right. It
    // proves the sentence is about this file, written by someone who had it
    // open. That is the whole of it.
    const thin = [];
    Object.keys(ALLOWED).forEach((file) => {
      const s = SOURCES.find((x) => x.file === file);
      Object.keys(ALLOWED[file]).forEach((sym) => {
        const why = String((ALLOWED[file][sym] || {}).why || '');
        const cited = citations(why, sym);
        if (!s || !cited.some((t) => s.src.indexOf(t) !== -1)) thin.push(file + ' → ' + sym);
      });
    });
    expect(thin).toEqual([]);
  });

  test('...and that check bites — a padded shrug fails it', () => {
    // Guards the guard: the rule is worthless if any long sentence passes.
    // 100+ characters of confident nothing — the exact thing `length >= 60` let
    // through.
    expect(citations('This one is fine and deliberate; it was reviewed and discussed and there is a good reason for it here.', 'renderJobsMain'))
      .toEqual([]);
    // Restating the excused symbol is not a citation either, however long the
    // sentence around it gets.
    expect(citations('renderJobsMain is called here, and renderJobsMain is fine, because renderJobsMain is what this does.', 'renderJobsMain'))
      .toEqual([]);
    // The suffixed forms name the same symbol, so they are stripped too.
    expect(citations('loadBillsForJob, deliberately unforced.', 'loadBillsForJob (no force)')).toEqual([]);
    expect(citations('arInvoices, read only.', 'arInvoices (destructured)')).toEqual([]);
    // ...and a real one names the code around the site.
    expect(citations('syncBillsToStore is reached from updateBillCell and loadBills.', 'jobVendorBills').sort())
      .toEqual(['loadBills', 'syncBillsToStore', 'updateBillCell']);
  });

  test('no two entries share a justification — a copy-pasted reason is one reason', () => {
    // The other way to satisfy a text check without reading anything: paste the
    // neighbour's sentence. Each site got its own excuse or it did not get one.
    const seen = Object.create(null), dupes = [];
    Object.keys(ALLOWED).forEach((file) => {
      Object.keys(ALLOWED[file]).forEach((sym) => {
        const key = String((ALLOWED[file][sym] || {}).why || '').replace(/\s+/g, ' ').trim();
        if (seen[key]) dupes.push(seen[key] + ' == ' + file + ' → ' + sym);
        else seen[key] = file + ' → ' + sym;
      });
    });
    expect(dupes.sort()).toEqual([]);
  });

  test('close() syncs the bill mirror OPTIMISTICALLY, and that is bounded to $0', () => {
    // C3.1, and the one item in this round that could have been behaviour rather
    // than prose. purchase-order-editor.js:156 calls syncBillsToStore() from
    // close() AFTER firing bills.remove DELETEs and BEFORE they resolve, so the
    // allowlist reason calling it post-resolve was wrong. The question that
    // matters is whether the ordering is a defect: if a DELETE fails, what does
    // the store hold?
    //
    // ANSWER: the store then lacks a row the server still has — the opposite
    // direction from the phantom-row bug the last commit fixed — and NO DOLLAR
    // CAN BE WRONG EITHER WAY, because the rows close() drops are $0 by the
    // predicate that selects them and every consumer sums `amount`. The residue
    // is a row COUNT (js/cost-buckets.js's `b.lines++`), self-healing on the next
    // forced bill refetch. Both halves of that argument are pinned here rather
    // than left in a sentence, because a sentence is what went wrong.
    const po = codeOnly(SOURCES.find((s) => s.file === 'purchase-order-editor.js').src);

    // FACT 1: the DELETEs are fire-and-forget and the sync does not wait.
    expect(po).toMatch(/window\.p86Api\.bills\.remove\(b\.id\)\.catch\(function \(\) \{\}\)/);
    expect(po).toMatch(/if \(_dropped\) syncBillsToStore\(\);/);
    // ...and the sync is NOT chained onto them — no .then anywhere on the drop.
    const closeBody = fnBody(po, 'close');
    expect(closeBody).not.toBeNull();
    expect({ then: (closeBody.match(/bills\.remove\([^)]*\)\s*\.then/g) || []).length }).toEqual({ then: 0 });

    // FACT 2: only $0, contentless rows are droppable. This is what bounds the
    // blast radius of a failed DELETE to a count.
    expect(closeBody).toMatch(/_ephemeral\s*&&\s*num\(b\.amount\)\s*===\s*0\s*&&\s*!String\(b\.description \|\| ''\)\.trim\(\)/);

    // FACT 3: the money consumers SUM amount, so a missing $0 row moves nothing.
    const jobs = codeOnly(SOURCES.find((s) => s.file === 'jobs.js').src);
    expect(fnBody(jobs, 'poRowBilled')).toMatch(/s \+ \(parseFloat\(b\.amount\) \|\| 0\)/);
    expect(fnBody(jobs, 'getJobBilledCost')).toMatch(/s \+ \(Number\(b\.amount\) \|\| 0\)/);

    // FACT 4: close()'s own p86Refresh is `po`, whose store half is
    // loadPurchaseOrdersForJob — it does NOT refetch bills. So the mirror is
    // reconciled by the next loadBillsForJob in EITHER ordering, which is why
    // awaiting the DELETEs here would buy nothing: it would only move a $0 count
    // patch to after the overlay is torn down and _po is null (syncBillsToStore
    // early-returns on !_po), i.e. trade a bounded stale count for a new race.
    expect(closeBody).toMatch(/window\.p86Refresh\('po', \{ jobId: _jobId \}\)/);
    const refresh = codeOnly(fs.readFileSync(path.join(REPO, 'js', 'refresh.js'), 'utf8'));
    const poEntry = /po:\s*\{[\s\S]*?\n    \}/.exec(refresh);
    expect(poEntry).not.toBeNull();
    expect(poEntry[0]).toContain('loadPurchaseOrdersForJob');
    expect(poEntry[0]).not.toContain('loadBillsForJob');
    expect(po).toMatch(/function syncBillsToStore\(\) \{\s*\n\s*if \(!_po \|\| !window\.appData\) return;/);
  });

  test('the scanner BITES — the exact shapes doc-import.js used are all caught', () => {
    // Guards the guard. Every pattern below is copied from what shipped.
    expect(bypassesIn('window.appData.jobPurchaseOrders = (window.appData.jobPurchaseOrders || []).concat(rec);'))
      .toEqual(['jobPurchaseOrders']);
    expect(bypassesIn('appData.jobChangeOrders = [];')).toEqual(['jobChangeOrders']);
    expect(bypassesIn('window.loadBillsForJob(it.jobId);'))
      .toEqual(['loadBillsForJob', 'loadBillsForJob (no force)']);
    expect(bypassesIn('  renderJobsMain();')).toEqual(['renderJobsMain']);
    expect(bypassesIn('if (typeof window.renderJobsMain === "function") window.renderJobsMain();'))
      .toEqual(['renderJobsMain']);
    // The unforced loader call is doc-import's OTHER defect and reports as its
    // own symbol, so it cannot be waved through by an excuse written about
    // owning the loader.
    expect(bypassesIn('loadBillsForJob(it.jobId);'))
      .toEqual(['loadBillsForJob', 'loadBillsForJob (no force)']);
    expect(bypassesIn('loadBillsForJob(jobId, true);')).toEqual(['loadBillsForJob']);
    // A nested call in the first argument is still ONE argument — the comma
    // scan is depth-aware, or `f(pick(a, b))` would read as forced.
    expect(bypassesIn('loadBillsForJob(pick(a, b));'))
      .toEqual(['loadBillsForJob', 'loadBillsForJob (no force)']);
  });

  test('the scanner catches the shapes doc-import did NOT use but the next one might', () => {
    // Widened beyond the bug that was found. None of these exists in js/ today
    // (verified: the whole tree's mirror writes are plain assignments), so every
    // one of them is here to fail the FIRST time someone writes it.
    expect(bypassesIn('appData.jobPurchaseOrders.push(rec);')).toEqual(['jobPurchaseOrders']);
    expect(bypassesIn('window.appData.jobVendorBills.splice(i, 1);')).toEqual(['jobVendorBills']);
    expect(bypassesIn('appData.arInvoices.unshift(row);')).toEqual(['arInvoices']);
    expect(bypassesIn('appData.jobChangeOrders.length = 0;')).toEqual(['jobChangeOrders']);
    // The computed property name — the obvious way around a dot-only pattern.
    expect(bypassesIn("appData['jobPurchaseOrders'] = rows;")).toEqual(['jobPurchaseOrders']);
    expect(bypassesIn('window.appData["arInvoices"].push(r);')).toEqual(['arInvoices']);
    // The three repainters that were NOT watched before this widening.
    expect(bypassesIn('p86JobsHubRefresh();')).toEqual(['p86JobsHubRefresh']);
    expect(bypassesIn('window.p86JobDetailRefresh(jobId);')).toEqual(['p86JobDetailRefresh']);
    expect(bypassesIn('p86RepaintJobMoneyTabs(String(cur));')).toEqual(['p86RepaintJobMoneyTabs']);
    // A call built inside a template literal is still source text, and is caught
    // for the same reason the `image/*` one is: nothing is being pre-stripped.
    expect(bypassesIn('var s = `${renderJobsMain()}`;')).toEqual(['renderJobsMain']);
  });

  test('the five shapes that used to be UNDOCUMENTED misses are caught', () => {
    // Each of these walked past the array-shaped patterns above and was not in
    // the "what this does not catch" list either — which is the worse of the two
    // failures, because the guard read as broader than it was.
    //
    // 1. An ELEMENT FIELD. The array is untouched; a money row is not.
    expect(bypassesIn('appData.jobVendorBills[0].amount = 5;')).toEqual(['jobVendorBills']);
    expect(bypassesIn('window.appData.arInvoices[i].status = "paid";')).toEqual(['arInvoices']);
    // 2. Object.assign's first argument — a write that reads like a read.
    expect(bypassesIn('Object.assign(appData.arInvoices, rows);')).toEqual(['arInvoices']);
    // 3. A destructuring bind. Not a write, but the alias that makes the NEXT
    //    line's write unfollowable, so it is reported under its own symbol.
    expect(bypassesIn('const { arInvoices } = window.appData;')).toEqual(['arInvoices (destructured)']);
    expect(bypassesIn('var { jobVendorBills, jobs } = appData;')).toEqual(['jobVendorBills (destructured)']);
    // 4. Optional chaining — what a defensive author types without thinking of
    //    it as evasion.
    expect(bypassesIn('window.appData?.arInvoices.push(r);')).toEqual(['arInvoices']);
    expect(bypassesIn('appData?.jobChangeOrders.splice(0, 1);')).toEqual(['jobChangeOrders']);
    // 5. delete — the least recoverable write of all: every reader then gets
    //    undefined rather than a stale number.
    expect(bypassesIn('delete window.appData.jobPurchaseOrders;')).toEqual(['jobPurchaseOrders']);
    expect(bypassesIn("delete appData['jobVendorBills'];")).toEqual(['jobVendorBills']);
  });

  test('C1: nine more DIRECT write classes — no alias, no runtime key, all were green', () => {
    // These are the ones the previous round's disclosure said could not exist.
    // It asserted that every remaining miss was "one class, four spellings" of
    // variable indirection; each shape below is literal, direct and
    // indirection-free, and every one of them walked past the scanner. Two are
    // the writes that round was ABOUT, in their direct form.
    //
    // NINE, counted honestly: classes 1-9 below are newly caught, and class 10 is
    // a REGRESSION CHECK on something that already worked — generalising the tail
    // must not lose `.length =`. Counting it as a tenth catch would be this
    // guard's own recurring mistake in miniature.
    //
    // Zero live instances when found — verified by scanning both roots through
    // this scanner's own stripper. Latent, which is when it is cheap.
    //
    // 1. COMPOUND ASSIGNMENT on a money field. The old tail required a plain
    //    `=`, so every read-modify-write spelling was invisible — and this is
    //    the one an author reaches for to adjust an amount rather than set it.
    expect(bypassesIn('appData.jobVendorBills[0].amount += 5;')).toEqual(['jobVendorBills']);
    expect(bypassesIn('appData.jobVendorBills[0].amount -= 5;')).toEqual(['jobVendorBills']);
    expect(bypassesIn('window.appData.arInvoices[i].balance *= 1.05;')).toEqual(['arInvoices']);
    // 2. INCREMENT, both fixities.
    expect(bypassesIn('appData.arInvoices[0].balance++;')).toEqual(['arInvoices']);
    expect(bypassesIn('appData.arInvoices[0].balance--;')).toEqual(['arInvoices']);
    expect(bypassesIn('--appData.arInvoices[0].balance;')).toEqual(['arInvoices']);
    expect(bypassesIn('++window.appData.jobVendorBills[0].amount;')).toEqual(['jobVendorBills']);
    // 3. A COMPUTED ELEMENT KEY. The computed form was matched for the MIRROR
    //    name and then hard-required a dot for the field.
    expect(bypassesIn("appData.jobVendorBills[0]['amount'] = 5;")).toEqual(['jobVendorBills']);
    // 4. A SECOND DOT HOP. One hop was allowed, two were not — and this exact
    //    shape is the Site Plan's CO building-allocation write, which is what
    //    the round that added the one-hop tail was about.
    expect(bypassesIn('appData.jobChangeOrders[0].data.buildingAllocations = alloc;'))
      .toEqual(['jobChangeOrders']);
    expect(bypassesIn('appData.jobVendorBills[0].data.description = t;')).toEqual(['jobVendorBills']);
    // 5. A WHOLE MONEY ROW REPLACED. No dot at all after the index — the bill
    //    mirror patch, in direct form.
    expect(bypassesIn('appData.jobVendorBills[0] = row;')).toEqual(['jobVendorBills']);
    expect(bypassesIn('appData.arInvoices[idx] = fresh;')).toEqual(['arInvoices']);
    // 6. Object.assign with appData ITSELF as argument 1. The old pattern
    //    required `appData.<mirror>` there, so naming the mirror in argument 2
    //    walked past it — while replacing the mirror just as wholesale.
    expect(bypassesIn('Object.assign(window.appData, { arInvoices: rows });')).toEqual(['arInvoices']);
    expect(bypassesIn('Object.assign(appData, { jobVendorBills: b, jobChangeOrders: c });'))
      .toEqual(['jobChangeOrders', 'jobVendorBills']);
    // ...and a multi-line object literal, since argsAt is brace-balanced.
    expect(bypassesIn('Object.assign(appData, {\n  arInvoices: rows\n});')).toEqual(['arInvoices']);
    // 7. LOGICAL ASSIGNMENT — the modern spelling of "initialise if absent",
    //    which is exactly what a defensive author writes before pushing.
    expect(bypassesIn('appData.jobVendorBills ??= [];')).toEqual(['jobVendorBills']);
    expect(bypassesIn('appData.jobVendorBills ||= [];')).toEqual(['jobVendorBills']);
    expect(bypassesIn('appData.jobVendorBills &&= [];')).toEqual(['jobVendorBills']);
    expect(bypassesIn("appData['arInvoices'] ??= [];")).toEqual(['arInvoices']);
    // 8. OPTIONAL CHAINING AND A COMPUTED KEY TOGETHER. Each was caught alone;
    //    the `?.` tolerance sat between `appData` and a DOTTED key only.
    expect(bypassesIn('appData?.["arInvoices"].push(r);')).toEqual(['arInvoices']);
    expect(bypassesIn('window.appData?.["jobVendorBills"] = rows;')).toEqual(['jobVendorBills']);
    // 9. A MUTATOR AT THE END OF A CHAIN, not directly on the mirror.
    expect(bypassesIn('appData.jobChangeOrders[0].data.lines.push(l);')).toEqual(['jobChangeOrders']);
    // 10. And `.length =` still works, now as a plain member hop rather than a
    //     special case — the generalisation must not lose what it replaced.
    expect(bypassesIn('appData.arInvoices.length = 0;')).toEqual(['arInvoices']);
  });

  test('C1: the widening did not make the scanner shout at reads', () => {
    // Widening a pattern is exactly when it starts matching things that are not
    // the defect, and a guard that cries wolf gets its allowlist padded until it
    // means nothing. Every read spelling the tree actually contains, pinned.
    //
    // Measured, not assumed: run against both roots, this widening changed ZERO
    // live counts — every allowlist entry above holds at the number it held
    // before. The six live element-level touches in the tree
    // (jobs.js:285/564/4599/4735, nodegraph/ui.js:2690/3993) are forEach/map
    // accumulations into locals, and they stay green because they are reads.
    expect(bypassesIn('appData.arInvoices.forEach(function (i) { total += i.amount; });')).toEqual([]);
    expect(bypassesIn('appData.jobVendorBills.map(function (b) { return b.amount; });')).toEqual([]);
    expect(bypassesIn('var n = appData.jobPurchaseOrders[0].amount;')).toEqual([]);
    expect(bypassesIn('var d = appData.jobChangeOrders[0].data.lines;')).toEqual([]);
    expect(bypassesIn('if (appData.arInvoices[0].status === "paid") ok();')).toEqual([]);
    expect(bypassesIn('if (appData.arInvoices[0].amount >= 5) ok();')).toEqual([]);
    expect(bypassesIn('if (appData.arInvoices[0].amount <= 5) ok();')).toEqual([]);
    expect(bypassesIn('if (appData.arInvoices[0].amount != 5) ok();')).toEqual([]);
    expect(bypassesIn('if (appData.arInvoices[0].amount !== 5) ok();')).toEqual([]);
    // ARITHMETIC vs COMPOUND ASSIGNMENT. Now that `+=` and `-=` are matched, the
    // bare operators must still not be — this is the specific way widening
    // ASSIGN_OP could have started reporting every subtraction in the tree.
    expect(bypassesIn('var d = appData.arInvoices[0].amount - 5;')).toEqual([]);
    expect(bypassesIn('var d = appData.arInvoices[0].amount + 5;')).toEqual([]);
    expect(bypassesIn('var d = appData.arInvoices[0].amount * 2;')).toEqual([]);
    expect(bypassesIn('var d = appData.arInvoices[0].amount / 2;')).toEqual([]);
    expect(bypassesIn('var d = appData.arInvoices[0].amount % 2;')).toEqual([]);
    // A negated read, where `-` sits next to a `-` one token away.
    expect(bypassesIn('var d = appData.arInvoices[0].amount - -1;')).toEqual([]);
    // Increment of something ELSE, on a line that reads a mirror.
    expect(bypassesIn('for (i++; i < appData.arInvoices.length; i++) {}')).toEqual([]);
    // The three operators whose ASSIGNMENT forms are now matched must not match
    // in their plain forms.
    expect(bypassesIn('var v = appData.arInvoices || [];')).toEqual([]);
    expect(bypassesIn('var v = appData.arInvoices ?? [];')).toEqual([]);
    expect(bypassesIn('var v = appData.arInvoices && appData.arInvoices.length;')).toEqual([]);
    expect(bypassesIn('var t = appData.arInvoices ? 1 : 2;')).toEqual([]);
    // A mirror read used as someone ELSE's key or argument is not a write to it.
    expect(bypassesIn('map[appData.jobVendorBills.length] = x;')).toEqual([]);
    expect(bypassesIn('obj[appData.arInvoices[0].id] = v;')).toEqual([]);
    expect(bypassesIn('foo(appData.arInvoices, appData.jobVendorBills);')).toEqual([]);
    // A chain that produces a COPY and sorts that is not an in-place mutation.
    expect(bypassesIn('var f = appData.arInvoices.filter(function (x) { return x; }).sort();')).toEqual([]);
    expect(bypassesIn('return appData.jobChangeOrders.slice();')).toEqual([]);
    expect(bypassesIn('var s = appData.jobVendorBills.reduce(function (a, b) { return a + b; }, 0);')).toEqual([]);
    // Object.assign READING a mirror into a fresh object — the mirror is not
    // argument 1, so nothing is mutated.
    expect(bypassesIn('var copy = Object.assign({}, appData.arInvoices[0]);')).toEqual([]);
    // ...and Object.assign onto appData naming NO mirror is not a mirror write.
    expect(bypassesIn('Object.assign(appData, { knownTrades: t });')).toEqual([]);
  });

  // ── THE ACCEPTANCE TEST: every shape, in every scanned root ───────────────
  // The standard this suite is held to is not "the guard passes" — a scanner
  // that mis-parses reports clean, and a scanner pointed at the wrong directory
  // reports clean too. It is: INJECT A BYPASS AND REQUIRE IT TO GO RED, per
  // shape, PER ROOT.
  //
  // The per-root half is the one that was missing, and it is what B1 was: nine
  // shapes went red in js/ and the same nine were green in nodegraph/, because
  // nodegraph/ was not being read at all. Splicing each shape into a REAL file
  // from each root proves the shape and the root together — a shape that passes
  // in one root and fails in another is that defect recurring.
  describe('acceptance: a bypass injected into ANY scanned root goes red', () => {
    const SHAPES = {
      'assign':            { code: 'appData.jobPurchaseOrders = rows;',            sym: 'jobPurchaseOrders' },
      'computed key':      { code: "appData['jobChangeOrders'] = rows;",           sym: 'jobChangeOrders' },
      'array mutate':      { code: 'appData.jobVendorBills.push(rec);',            sym: 'jobVendorBills' },
      'length truncate':   { code: 'appData.arInvoices.length = 0;',               sym: 'arInvoices' },
      'element field':     { code: 'appData.jobVendorBills[0].amount = 5;',        sym: 'jobVendorBills' },
      'Object.assign':     { code: 'Object.assign(appData.arInvoices, rows);',     sym: 'arInvoices' },
      'optional chain':    { code: 'window.appData?.arInvoices.push(r);',          sym: 'arInvoices' },
      'delete':            { code: 'delete window.appData.jobPurchaseOrders;',     sym: 'jobPurchaseOrders' },
      'destructure':       { code: 'const { arInvoices } = window.appData;',       sym: 'arInvoices (destructured)' },
      // ── C1: the nine classes (ten spellings, both increment fixities) that were
      // green in BOTH roots while the disclosure said they could not exist
      'compound assign':   { code: 'appData.jobVendorBills[0].amount += 5;',       sym: 'jobVendorBills' },
      'postfix increment': { code: 'appData.arInvoices[0].balance++;',             sym: 'arInvoices' },
      'prefix increment':  { code: '--appData.arInvoices[0].balance;',             sym: 'arInvoices' },
      'computed elt key':  { code: "appData.jobVendorBills[0]['amount'] = 5;",     sym: 'jobVendorBills' },
      'nested field':      { code: 'appData.jobChangeOrders[0].data.buildingAllocations = a;', sym: 'jobChangeOrders' },
      'whole money row':   { code: 'appData.jobVendorBills[0] = row;',             sym: 'jobVendorBills' },
      'assign onto root':  { code: 'Object.assign(window.appData, { arInvoices: rows });', sym: 'arInvoices' },
      'logical assign':    { code: 'appData.jobVendorBills ??= [];',               sym: 'jobVendorBills' },
      'chain + computed':  { code: 'appData?.["arInvoices"].push(r);',             sym: 'arInvoices' },
      'nested mutator':    { code: 'appData.jobChangeOrders[0].data.lines.push(l);', sym: 'jobChangeOrders' },
      'loader (forced)':   { code: 'window.loadBillsForJob(jid, true);',           sym: 'loadBillsForJob' },
      'loader (unforced)': { code: 'loadBillsForJob(jid);',                        sym: 'loadBillsForJob (no force)' },
      'repaint bare':      { code: 'renderJobsMain();',                            sym: 'renderJobsMain' },
      'repaint window.':   { code: 'window.p86RepaintJobMoneyTabs(String(cur));',  sym: 'p86RepaintJobMoneyTabs' },
      'repaint detail':    { code: 'window.p86JobDetailRefresh(jobId);',           sym: 'p86JobDetailRefresh' },
      'hub refresh':       { code: 'p86JobsHubRefresh();',                         sym: 'p86JobsHubRefresh' }
    };
    // One real, large file per root — injecting into a stub would prove nothing
    // about the file's own comments, strings and CRLF.
    const HOSTS = SCRIPT_ROOTS.map((dir) => SOURCES
      .filter((s) => s.dir === dir)
      .sort((a, b) => b.src.length - a.src.length)[0]);

    test('every scanned root has a host file to inject into', () => {
      expect(HOSTS.map((h) => h && h.dir)).toEqual(SCRIPT_ROOTS);
      expect(SCRIPT_ROOTS.length).toBeGreaterThanOrEqual(2);
    });

    HOSTS.forEach((host) => {
      Object.keys(SHAPES).forEach((name) => {
        test(host.dir + '/ · ' + name, () => {
          const { code, sym } = SHAPES[name];
          const before = countsIn(host.src)[sym] || 0;
          const after = countsIn(host.src + '\nfunction _inj(){ ' + code + ' }\n')[sym] || 0;
          // The COUNT must rise. Presence alone would pass on a file that
          // already had a live site of that symbol — which is how the
          // per-file-per-symbol allowlist hid V5.
          expect({ root: host.dir, shape: name, before, after })
            .toEqual({ root: host.dir, shape: name, before, after: before + 1 });
        });
      });
    });

    test('the hub-refresh scan reaches every root too, not just the mirror scan', () => {
      // p86JobsHubRefresh has its OWN whole-tree scan above (HUB_CALL), which
      // was reading the same js/-only SOURCES. Same injection, same requirement.
      HOSTS.forEach((host) => {
        const before = (codeOnly(host.src).match(HUB_CALL) || []).length;
        const after = (codeOnly(host.src + '\nfunction _inj(){ p86JobsHubRefresh(); }\n').match(HUB_CALL) || []).length;
        expect({ root: host.dir, before, after }).toEqual({ root: host.dir, before, after: before + 1 });
      });
    });
  });

  // ── WHAT THIS SCANNER DOES NOT CATCH ──────────────────────────────────────
  // A source scan is only as good as its parser, and the honest failure of a
  // guard like this is not "it broke" — it is "it kept passing". So the misses
  // are pinned as tests rather than left to be discovered. If one of these ever
  // starts being caught, this test fails and the comment above the guard gets
  // to become less apologetic.
  //
  // TWO CLASSES, and the count matters because the previous version of this
  // paragraph asserted ONE. It said: "Every miss below shares one root: the
  // scanner matches TEXT, it does not resolve VALUES. An indirection through a
  // variable defeats it, always." — and then: "this list is the whole remainder:
  // one class, four spellings of it."
  //
  // BOTH SENTENCES WERE FALSE, and the way they were false is the pattern this
  // pass exists to break: each time the guard closed a gap it wrote a sentence
  // one size larger than the fix. NINE CLASSES of direct, literal,
  // indirection-free write were green at the time that claim was made — compound
  // assignment, increment at either fixity, a computed element key, a second dot
  // hop, a bare `[0] =`, `Object.assign` onto `appData` itself,
  // `??=`/`||=`/`&&=`, `?.` with a computed key, and a mutator at the end of a
  // chain — two of them the very writes that round was about. They are caught now
  // (see the C1 tests above); none of them was variable indirection.
  //
  // So the remainder is stated as two classes, and neither is claimed to be the
  // last one. It is what is known to escape today, not a proof of completeness:
  //
  //   CLASS 1 — INDIRECTION THROUGH A VALUE. The mirror, the loader or the key
  //     is bound to a name first and used under that name. This one really is
  //     unreachable for a text scan.
  //   CLASS 2 — A WRITE THROUGH A BINDING THE LANGUAGE CREATES: a callback
  //     parameter or a loop variable. `forEach`/`map`/`find`/`for…of` hand an
  //     ELEMENT to a name the scanner has never seen, and the write is on that
  //     name. This is NOT class 1 — nothing is aliased, no assignment
  //     introduces the name, and the code is the most natural spelling there is
  //     — which is exactly why folding it into "an indirection through a
  //     variable" made the one-class sentence untrue.
  //
  // Class 2 is the more dangerous of the two, and it is named here rather than
  // hidden because closing it needs a real parser: you have to know that the
  // callback's parameter is bound to an element OF a watched mirror, which is
  // type inference, not pattern matching. Someone closing it should reach for a
  // JS AST (the receiver of the `.forEach` is right there in the tree) rather
  // than widening a regex — a regex that matched `i.status =` inside any
  // callback would fire on every unrelated loop in 121 files.
  test('the misses are named, not implied — this is a text scan, not a type check', () => {
    // ── CLASS 1: indirection through a value ────────────────────────────────
    // 1. A store write through a local alias. The mirror is aliased once and
    //    then mutated under a name the scanner has never heard of.
    expect(bypassesIn('var m = appData.arInvoices; m.push(row);')).toEqual([]);
    expect(bypassesIn('var m = appData.jobVendorBills; m[0].amount = 5;')).toEqual([]);
    // 2. A loader or repainter called through an alias, same reason.
    expect(bypassesIn('var f = window.loadBillsForJob; f(jobId);')).toEqual([]);
    expect(bypassesIn('var r = window["renderJobsMain"]; r();')).toEqual([]);
    // 3. A computed key built at runtime rather than written as a literal.
    expect(bypassesIn("appData['job' + 'VendorBills'] = rows;")).toEqual([]);
    expect(bypassesIn('appData[MIRROR] = rows;')).toEqual([]);
    // 4. A call assembled from a string.
    expect(bypassesIn('window["load" + "BillsForJob"](jobId);')).toEqual([]);
    // 5. Object.assign onto appData whose PATCH is a variable — the mirror is
    //    never named, so there is nothing to report it under. This is the
    //    boundary of the C1 fix above, and it is class 1, not a new class.
    expect(bypassesIn('Object.assign(appData, patch);')).toEqual([]);

    // ── CLASS 2: a write through a binding the LANGUAGE creates ─────────────
    // The element is handed to a callback parameter or a loop variable, and the
    // write is on that name. Nothing is aliased by an assignment; this is the
    // most direct spelling available, which is what makes it its own class.
    expect(bypassesIn('appData.arInvoices.forEach(function (i) { i.status = "paid"; });')).toEqual([]);
    expect(bypassesIn('appData.arInvoices.forEach(i => { i.status = "paid"; });')).toEqual([]);
    expect(bypassesIn('appData.jobVendorBills.map(function (b) { b.amount = 0; return b; });')).toEqual([]);
    expect(bypassesIn('appData.jobVendorBills.find(function (b) { return b.id === x; }).amount = 5;')).toEqual([]);
    expect(bypassesIn('for (var b of appData.jobVendorBills) { b.amount = 0; }')).toEqual([]);
    expect(bypassesIn('for (var i = 0; i < appData.arInvoices.length; i++) { var r = appData.arInvoices[i]; r.status = "paid"; }')).toEqual([]);

    // WHY CLASS 1 IS ACCEPTABLE, stated rather than assumed: it requires an
    // indirection nobody writes by accident. The defect this guard exists to
    // stop — doc-import.js — was written in the most direct form available,
    // because that is what someone reaching for the read-cache naturally types.
    //
    // CLASS 2 IS NOT ACCEPTABLE IN THE SAME WAY, and the honest thing is to say
    // so rather than to file it under the same excuse: it needs no indirection
    // and someone WILL type it. It is disclosed, not defended.
    //
    // The guard is a tripwire against the ordinary mistake, not a sandbox
    // against a determined author, and it must not be described as the second
    // thing. What it does NOT get to be described as either is complete: this
    // list is what is known to escape, and the last two rounds each found a
    // shape that the round before had implied could not exist.
  });

  test('...and does not fire on the shapes that are NOT writes or calls', () => {
    // A comparison is not an assignment.
    expect(bypassesIn('if (appData.arInvoices == null) return;')).toEqual([]);
    expect(bypassesIn('if (appData.jobVendorBills === undefined) return;')).toEqual([]);
    // A capability probe is not a call.
    expect(bypassesIn('if (typeof window.loadBillsForJob === "function") ok();')).toEqual([]);
    // A registry `paths` entry is a STRING naming the loader, not an invocation.
    expect(bypassesIn("var paths = ['loadBillsForJob'].concat(REPAINT);")).toEqual([]);
    // A read is not a write.
    expect(bypassesIn('var n = appData.jobPurchaseOrders.length;')).toEqual([]);
  });

  test('...and comments are not code — including in the CRLF the tree actually uses', () => {
    // Every module that was FIXED now documents in prose exactly what it used to
    // do. If the stripper stopped working, each of those explanations would be
    // reported as the defect it describes — which is how a guard starts failing
    // on the fix instead of the bug.
    expect(bypassesIn('// called loadBillsForJob(jobId) with no force')).toEqual([]);
    expect(bypassesIn('  // hand-concated into appData.jobPurchaseOrders = ... and repainted')).toEqual([]);
    expect(bypassesIn('  // one bare renderJobsMain() that painted first\r\nvar x = 1;\r\n')).toEqual([]);
    // THE PHANTOM-COMMENT TRAP, as a first-class fixture. A naive /* */ strip is
    // broken by this exact string in js/estimate-editor.js: the `/*` inside it
    // opens a block comment that swallows every line to the next `*/`, so the
    // scan reports a clean file and the bite test passes when it should fail.
    const trap = 'var a = "application/pdf,image/*";\nwindow.loadBillsForJob(jobId);';
    expect(bypassesIn(trap)).toEqual(['loadBillsForJob', 'loadBillsForJob (no force)']);
    const trapCrlf = 'var a = "application/pdf,image/*";\r\nappData.jobVendorBills = rows;\r\n';
    expect(bypassesIn(trapCrlf)).toEqual(['jobVendorBills']);
    // The same trap against the widened patterns, because widening a scanner is
    // exactly when its stripper stops being re-checked. js/jobs-hub.js:838 also
    // carries `image/*`, and the bulk-bar checks below sit downstream of it —
    // one real `*/` away from having been swallowed too.
    expect(bypassesIn('accept="application/pdf,image/*"\np86RepaintJobMoneyTabs(id);'))
      .toEqual(['p86RepaintJobMoneyTabs']);
    expect(bypassesIn("accept=\"image/*\"\nappData['arInvoices'].push(r);")).toEqual(['arInvoices']);
  });

  test('Bulk Document Import goes through the registry and nowhere else', () => {
    // The positive half: not merely "no bypass" (deleting the refresh entirely
    // would pass that), but that it actually fires p86Refresh — once per JOB for
    // the whole batch, not once per document.
    const di = codeOnly(SOURCES.find((s) => s.file === 'doc-import.js').src);
    expect(bypassesIn(SOURCES.find((s) => s.file === 'doc-import.js').src)).toEqual([]);
    const body = fnBody(di, 'refreshCreated');
    expect(body).not.toBeNull();
    expect(body).toMatch(/window\.p86Refresh\(type,\s*\{\s*jobId:\s*j\s*\}\)/);
    // Mapped from the import's own entity vocabulary — `invoice` is a vendor
    // Bill, so it must refresh `bill` and not a type that does not exist.
    expect(di).toMatch(/REFRESH_TYPE\s*=\s*\{\s*po:\s*'po',\s*co:\s*'co',\s*invoice:\s*'bill'\s*\}/);
    // Fired ONCE, from the batch's completion arm — not from createOne.
    expect({ calls: (di.match(/refreshCreated\s*\(/g) || []).length }).toEqual({ calls: 2 });  // 1 def + 1 call
    const one = fnBody(di, 'createOne');
    expect(one).not.toBeNull();
    expect({ inCreateOne: (one.match(/refreshCreated\s*\(|p86Refresh\s*\(/g) || []).length })
      .toEqual({ inCreateOne: 0 });
  });
});

// ── the bulk ribbon and the rows must agree ─────────────────────────────────
describe('a cleared bulk selection is cleared on screen too', () => {
  const HUB = codeOnly(SOURCES.find((s) => s.file === 'jobs-hub.js').src);

  test('afterBulk drops the selection in the DOM, not only in the model', () => {
    // afterBulk cleared `_selected` and hid the ribbon but left the checkboxes
    // ticked, so for the ~200ms until the refetch repainted, rows sat selected
    // with no ribbon. It self-corrected on repaint, which is exactly why it
    // survived review — and exactly why it needs a test rather than a memory.
    const body = fnBody(HUB, 'afterBulk');
    expect(body).not.toBeNull();
    expect({ clear: (body.match(/\bclearSelection\s*\(/g) || []).length }).toEqual({ clear: 1 });
    // And the helper really unchecks, rather than being a rename of _selected.clear().
    const helper = fnBody(HUB, 'clearSelection');
    expect(helper).not.toBeNull();
    expect(helper).toMatch(/_selected\.clear\(\)/);
    expect(helper).toMatch(/\.jh-check.*b\.checked\s*=\s*false/);
    expect(helper).toMatch(/indeterminate\s*=\s*false/);
  });

  test('the ribbon Clear button and afterBulk use the SAME helper', () => {
    // Two copies of "drop the selection" is how they came to disagree.
    // `(?<!function )` so the declaration is not counted as one of the uses.
    expect({ uses: (HUB.match(/(?<!function )\bclearSelection\s*\(\s*\)/g) || []).length })
      .toEqual({ uses: 2 });   // afterBulk + the ribbon's onClear
  });
});

// ── a repaint called with no id repaints nothing ────────────────────────────
describe('the job-card repaint is given the job it is meant to repaint', () => {
  test('syncEstimateToJob passes est.job_id to p86RerenderJobCards', () => {
    // p86RerenderJobCards(jobId) hands its argument straight to
    // renderJobBuildings(jobId, host) and to the phases filter. Called bare it
    // ran both with `undefined`, matched nothing, and left the building + phase
    // cards on the pre-sync contract — a repaint that reported success and
    // moved no pixel. Every other call site in js/jobs.js passes an id; this
    // was the only one that did not.
    const ee = codeOnly(SOURCES.find((s) => s.file === 'estimate-editor.js').src);
    const bare = ee.match(/p86RerenderJobCards\(\s*\)/g) || [];
    expect(bare).toEqual([]);
    expect(ee).toMatch(/window\.p86RerenderJobCards\(est\.job_id\)/);
  });
});
