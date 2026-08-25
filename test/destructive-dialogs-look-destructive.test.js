// test/destructive-dialogs-look-destructive.test.js
//
// NO DIALOG THAT CAN DESTROY PRESENTS ITSELF AS ROUTINE.
//
// There are TWO p86Confirm implementations in this app and only one of them
// runs. js/dialogs.js defines one and assigns it to window.p86Confirm;
// js/app.js defines another and assigns it to window.p86Confirm as well.
// index.html loads dialogs.js at line 3393 and app.js at 3492, both at top
// level, so app.js's assignment is second and wins.
//
// They spell their options differently:
//
//   js/app.js     confirmText   destructive   cancelText     ← the live one
//   js/dialogs.js confirmLabel  danger        cancelLabel    ← shadowed
//
// and THE DEAD ONE CARRIES THE DOCUMENTATION. Its JSDoc block was the only
// description of either function, so call sites were written against it, and
// the live function read none of those names. The result was not an error —
// it was a DEFAULT: a plain blue button reading "Confirm" on an irreversible
// action. "Delete job permanently — and all its buildings, phases, subs and
// change orders" looked exactly like saving one.
//
// The properties here are about the whole app, not about one dialog:
//
//   D1  THE LIVE IMPLEMENTATION IS KNOWN — which of the two wins is asserted
//       from index.html's load order and from the rendered button, not assumed
//   D2  BOTH SPELLINGS ARE HONOURED — a label asked for is a label shown, a
//       red asked for is a red shown, in either vocabulary
//   D3  NOTHING THAT WORKED CHANGES — a caller using the live spelling gets
//       byte-identical markup to before
//   D4  EVERY CALL SITE IN THE APP IS ENUMERATED, and every one that asks for
//       a label or a danger colour gets it. This is the property; the nine
//       names below are only what it happened to find.
//
// The enumeration is a WALK OF THE SOURCE, not a list. A list would go stale
// the moment somebody adds a dialog, which is exactly how nine of them went
// unnoticed.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const JS = path.join(ROOT, 'js');
const PRIOR_SHA = '8aef6d8d';

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\r\n').join('\n');
const prior = (rel) => {
  try {
    return execFileSync('git', ['show', PRIOR_SHA + ':' + rel],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 })
      .split('\r\n').join('\n');
  } catch (e) { return null; }
};

// ── THE LIVE FUNCTION, LIFTED BY ANCHOR ───────────────────────────────
// js/app.js cannot be loaded whole in jsdom — it boots the application. The
// p86Confirm assignment is a top-level statement, so it is lifted verbatim and
// evaluated in the same order the browser evaluates it: after dialogs.js.
function liftConfirm(appSrc) {
  const a = appSrc.indexOf('        window.p86Confirm = function(opts) {');
  if (a < 0) throw new Error('p86Confirm assignment not found in js/app.js');
  const b = appSrc.indexOf('\n        };\n', a);
  const stmt = appSrc.slice(a, b + 11);
  if (stmt.length < 1500) throw new Error('lift too small: ' + stmt.length);
  return stmt;
}

// Boot a window the way index.html does: dialogs.js first, then app.js's
// assignment. Anything else would be measuring a load order the app does not
// have.
function bootDialogs(opts) {
  const o = opts || {};
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'dangerously', url: 'https://project86.net/' });
  const w = dom.window;
  w.eval(`window.escapeHTML = function(s){ if(s===null||s===undefined) return '';
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#39;'); };`);
  const add = (txt) => { const s = w.document.createElement('script'); s.textContent = txt; w.document.body.appendChild(s); };
  add(o.dialogs || read('js/dialogs.js'));
  const afterDialogs = String(w.p86Confirm);
  add(o.confirmStmt || liftConfirm(read('js/app.js')));
  return { w, dom, afterDialogs, afterApp: String(w.p86Confirm) };
}

// Raise a dialog, read the button back, then dismiss it.
function render(w, opts) {
  w.p86Confirm(opts);
  const btn = w.document.querySelector('[data-confirm-ok],[data-p86-confirm]');
  const cancel = w.document.querySelector('[data-confirm-cancel],[data-p86-cancel]');
  const body = w.document.querySelector('.p86-confirm-overlay, .p86-dialog-modal, .modal-content');
  const out = {
    label: btn ? btn.textContent : null,
    cls: btn ? btn.className : null,
    cancel: cancel ? cancel.textContent : null,
    html: body ? body.innerHTML : null,
    red: btn ? /\bdanger\b/.test(btn.className) : null,
  };
  if (cancel) cancel.click();
  const ov = w.document.querySelector('.p86-confirm-overlay');
  if (ov && ov.parentNode) ov.parentNode.removeChild(ov);
  Array.from(w.document.body.children).forEach((el) => {
    if (el.tagName !== 'SCRIPT') el.remove();
  });
  return out;
}

let BOOT;
beforeAll(() => { BOOT = bootDialogs(); });
afterAll(() => { try { BOOT.dom.window.close(); } catch (e) {} });

// ══════════════════════════════════════════════════════════════════════
// D1 — WHICH IMPLEMENTATION RUNS.
// ══════════════════════════════════════════════════════════════════════
describe('D1 the live p86Confirm is the one in js/app.js', () => {
  test('index.html loads dialogs.js BEFORE app.js, both at top level', () => {
    const idx = read('index.html');
    const d = idx.indexOf('js/dialogs.js');
    const a = idx.indexOf('js/app.js?');
    expect(d).toBeGreaterThan(0);
    expect(a).toBeGreaterThan(d);
  });

  test('both files assign window.p86Confirm, and the second one wins', () => {
    expect(read('js/dialogs.js')).toContain('window.p86Confirm = p86Confirm;');
    expect(read('js/app.js')).toContain('window.p86Confirm = function(opts) {');
    // Not inferred — the function object on `window` is compared before and
    // after app.js's statement runs.
    expect(BOOT.afterDialogs).not.toBe(BOOT.afterApp);
    expect(BOOT.afterDialogs).toContain('showDialog');       // dialogs.js
    expect(BOOT.afterApp).toContain('p86-confirm-overlay');  // app.js
  });

  test('only p86Confirm is shadowed — dialogs.js still owns the other three', () => {
    expect(String(BOOT.w.p86Alert)).toContain('p86-dialog-title');
    expect(String(BOOT.w.p86Prompt)).toContain('p86-dialog');
    expect(String(BOOT.w.p86ConfirmTernary)).toContain('p86-dialog');
  });

  test('the shadowed JSDoc says so, so the next reader is not trapped by it', () => {
    const d = read('js/dialogs.js');
    const i = d.indexOf('   * p86Confirm — yes/no confirmation modal.');
    const block = d.slice(i, d.indexOf('*/', i));
    expect(block).toContain('DOES NOT RUN');
    expect(block).toContain('js/app.js');
  });
});

// ══════════════════════════════════════════════════════════════════════
// D2 — BOTH SPELLINGS ARE HONOURED.
// ══════════════════════════════════════════════════════════════════════
describe('D2 a label asked for is shown; a red asked for is red', () => {
  const CASES = [
    ['app.js spelling',      { confirmText: 'Delete', destructive: true },  'Delete',  true],
    ['dialogs.js spelling',  { confirmLabel: 'Delete', danger: true },      'Delete',  true],
    ['both, agreeing',       { confirmText: 'Delete', confirmLabel: 'Delete', destructive: true, danger: true }, 'Delete', true],
    ['label only, no red',   { confirmLabel: 'Archive' },                   'Archive', false],
    ['red only, no label',   { danger: true },                              'Confirm', true],
    ['neither',              {},                                            'Confirm', false],
  ];

  test.each(CASES)('%s', (name, opts, label, red) => {
    const r = render(BOOT.w, Object.assign({ title: 'T', message: 'M' }, opts));
    expect(r.label).toBe(label);
    expect(r.red).toBe(red);
  });

  test('the cancel label is honoured in either spelling', () => {
    expect(render(BOOT.w, { message: 'M', cancelText: 'Keep' }).cancel).toBe('Keep');
    expect(render(BOOT.w, { message: 'M', cancelLabel: 'Keep' }).cancel).toBe('Keep');
    expect(render(BOOT.w, { message: 'M' }).cancel).toBe('Cancel');
  });

  test('a bare string is the MESSAGE, not a discarded argument', () => {
    const r = render(BOOT.w, 'Clear all chats? They will be archived.');
    expect(r.html).toContain('Clear all chats?');
    // Four call sites pass one — js/ai-panel.js:2760, js/cowork.js:759,
    // js/payload-artifact.js:393 and js/admin.js:5989 — and every one of them
    // was rendering an EMPTY body under "Are you sure?".
    expect(r.html).not.toBe('');
  });

  test('an explicit destructive:false is still honoured over a stray danger', () => {
    // `destructive` is tested for PRESENCE, not OR'd, so a caller that already
    // says "not destructive" in the live vocabulary cannot be overruled by the
    // other one. This is what makes accepting both incapable of regressing.
    const r = render(BOOT.w, { message: 'M', destructive: false, danger: true });
    expect(r.red).toBe(false);
  });

  test('the PRIOR bytes dropped both, on every dialogs.js-spelled call', () => {
    const boot = bootDialogs({ confirmStmt: liftConfirm(prior('js/app.js')) });
    const r = render(boot.w, { title: 'T', message: 'M', confirmLabel: 'Delete', danger: true });
    expect(r.label).toBe('Confirm');   // the label was thrown away
    expect(r.red).toBe(false);         // and so was the red
    boot.dom.window.close();
  });
});

// ══════════════════════════════════════════════════════════════════════
// D3 — NOTHING THAT WORKED CHANGES.
// ══════════════════════════════════════════════════════════════════════
describe('D3 a caller using the live spelling renders exactly as before', () => {
  test('byte-identical markup against the prior bytes', () => {
    const boot = bootDialogs({ confirmStmt: liftConfirm(prior('js/app.js')) });
    const SAME = [
      { title: 'Explode assembly', message: 'M', confirmText: 'Explode', destructive: true },
      { title: 'Delete this line?', message: 'This cannot be undone.', confirmText: 'Delete', destructive: true },
      { title: 'Unlock estimate', message: 'M', confirmText: 'Unlock' },
      { title: 'T', message: 'M' },
      { title: 'T', message: '' },
      { title: '', message: 'M', cancelText: 'Nope' },
    ];
    SAME.forEach((opts) => {
      expect(render(BOOT.w, opts).html).toBe(render(boot.w, opts).html);
    });
    boot.dom.window.close();
  });
});

// ══════════════════════════════════════════════════════════════════════
// D4 — EVERY CALL SITE IN THE APP.
// ══════════════════════════════════════════════════════════════════════
describe('D4 every p86Confirm call site in js/ gets the dialog it asked for', () => {
  // Walk the source for p86Confirm( calls and read the option OBJECT the call
  // site writes, by balancing parentheses from the opening one. Deliberately
  // not a regex over the whole argument — a nested object or a ternary would
  // slip past one.
  function callSites() {
    const rows = [];
    fs.readdirSync(JS).filter((f) => f.endsWith('.js')).forEach((f) => {
      const src = fs.readFileSync(path.join(JS, f), 'utf8').split('\r\n').join('\n');
      let i = 0;
      while ((i = src.indexOf('p86Confirm(', i)) !== -1) {
        const pre = src.slice(Math.max(0, i - 40), i);
        // Skip the definitions themselves and `typeof window.p86Confirm ===`.
        if (/function\s+$|=\s*function|window\.p86Confirm\s*=\s*$/.test(pre)) { i += 11; continue; }
        let d = 0, j = i + 10, end = -1;
        for (; j < src.length; j++) {
          const c = src[j];
          if (c === '(') d++;
          else if (c === ')') { d--; if (d === 0) { end = j; break; } }
        }
        const arg = src.slice(i + 10, end + 1);
        rows.push({
          file: f, line: src.slice(0, i).split('\n').length, arg,
          confirmText: /\bconfirmText\s*:/.test(arg),
          confirmLabel: /\bconfirmLabel\s*:/.test(arg),
          destructive: /\bdestructive\s*:/.test(arg),
          danger: /\bdanger\s*:/.test(arg),
          cancelText: /\bcancelText\s*:/.test(arg),
          cancelLabel: /\bcancelLabel\s*:/.test(arg),
          objArg: /^\(\s*\{/.test(arg),
        });
        i = end > 0 ? end : i + 11;
      }
    });
    return rows;
  }

  const SITES = callSites();

  test('the walk finds the whole population, not a sample', () => {
    // If this ever collapses to a handful, the walk broke and every property
    // below it goes vacuously green.
    expect(SITES.length).toBeGreaterThan(50);
    expect(new Set(SITES.map((s) => s.file)).size).toBeGreaterThan(15);
    // The two explode dialogs this work started from are in it.
    expect(SITES.some((s) => s.file === 'change-order-editor.js' && s.confirmText && s.destructive)).toBe(true);
    expect(SITES.some((s) => s.file === 'estimate-editor.js' && s.confirmText && s.destructive)).toBe(true);
  });

  test('every site that asks for a LABEL, in either vocabulary, gets one', () => {
    const asked = SITES.filter((s) => s.confirmText || s.confirmLabel);
    expect(asked.length).toBeGreaterThan(20);
    const dropped = asked.filter((s) => {
      // Reconstruct what the live function would read. Only the names matter,
      // so a site is satisfied when at least one of the two is a name the live
      // function now honours — which, after this change, both are.
      const r = render(BOOT.w, { message: 'M', confirmText: s.confirmText ? 'L' : undefined,
        confirmLabel: s.confirmLabel ? 'L' : undefined });
      return r.label !== 'L';
    });
    expect(dropped.map((s) => s.file + ':' + s.line)).toEqual([]);
  });

  test('every site that asks for RED, in either vocabulary, gets red', () => {
    const asked = SITES.filter((s) => s.destructive || s.danger);
    expect(asked.length).toBeGreaterThan(20);
    const plain = asked.filter((s) => {
      const r = render(BOOT.w, { message: 'M',
        destructive: s.destructive ? true : undefined,
        danger: s.danger ? true : undefined });
      return r.red !== true;
    });
    expect(plain.map((s) => s.file + ':' + s.line)).toEqual([]);
  });

  test('THE NINE that were broken, named — and each one is fixed', () => {
    // These are recorded because John should know the extent: for as long as
    // these have existed, deleting a job permanently showed the same plain
    // blue "Confirm" as saving one. The list is derived from the walk, not
    // typed in, so it cannot drift from the source.
    const brokenBefore = SITES
      .filter((s) => (s.confirmLabel || s.danger || s.cancelLabel)
                  && !(s.confirmText || s.destructive || s.cancelText))
      .map((s) => s.file + ':' + s.line);
    expect(brokenBefore.sort()).toEqual([
      'ai-panel.js:2992',        // "Clear conversation"
      'attachments.js:1109',     // "Delete attachment"
      'estimates.js:1056',       // "Delete estimate"
      'file-explorer.js:157',    // every file and folder delete — red dropped
      'jobs.js:2788',            // "Archive job" — label dropped
      'jobs.js:2809',            // "Delete job permanently" + all its children
      'schedule.js:3027',        // "Delete event"
      'schedule.js:3442',        // "Delete schedule entry"
      'schedule.js:3548',        // "Your unsaved changes will be lost"
    ].sort());

    // Each of them, rendered through the live function, now shows what it asked
    // for — measured against the PRIOR bytes rendering the same options.
    const boot = bootDialogs({ confirmStmt: liftConfirm(prior('js/app.js')) });
    const real = [
      { file: 'jobs.js:2809', opts: { title: 'Delete job permanently', message: 'M', confirmLabel: 'Delete', danger: true }, label: 'Delete', red: true },
      { file: 'estimates.js:1056', opts: { title: 'Delete estimate', message: 'M', confirmLabel: 'Delete', danger: true }, label: 'Delete', red: true },
      { file: 'attachments.js:1109', opts: { title: 'Delete attachment', message: 'M', confirmLabel: 'Delete', danger: true }, label: 'Delete', red: true },
      { file: 'schedule.js:3027', opts: { title: 'Delete event', message: 'M', confirmLabel: 'Delete', danger: true }, label: 'Delete', red: true },
      { file: 'schedule.js:3442', opts: { title: 'Delete schedule entry', message: 'M', confirmLabel: 'Delete', danger: true }, label: 'Delete', red: true },
      { file: 'ai-panel.js:2992', opts: { title: 'Clear conversation', message: 'M', confirmLabel: 'Clear', danger: true }, label: 'Clear', red: true },
      { file: 'file-explorer.js:157', opts: { title: 'Confirm', message: 'M', danger: true }, label: 'Confirm', red: true },
      { file: 'jobs.js:2788', opts: { title: 'Archive job', message: 'M', confirmLabel: 'Archive' }, label: 'Archive', red: false },
      { file: 'schedule.js:3548', opts: { title: 'Entry changed elsewhere', message: 'M', confirmLabel: 'Reload', cancelLabel: 'Keep mine' }, label: 'Reload', red: false },
    ];
    real.forEach((c) => {
      const now = render(BOOT.w, c.opts);
      expect([c.file, now.label, now.red]).toEqual([c.file, c.label, c.red]);
      const was = render(boot.w, c.opts);
      // …and every one of them was WRONG before, or this test proves nothing.
      expect([c.file, was.label === c.label && was.red === c.red]).toEqual([c.file, false]);
    });
    boot.dom.window.close();
  });

  test('the sites that already hedged are unaffected', () => {
    // p86Ask in js/change-order-editor.js:7 and its copies pass BOTH
    // vocabularies — somebody had already worked this out — and they must
    // render exactly as they did.
    const boot = bootDialogs({ confirmStmt: liftConfirm(prior('js/app.js')) });
    const hedged = { title: 'Confirm', message: 'M', confirmLabel: 'Go', confirmText: 'Go',
      cancelLabel: 'Cancel', cancelText: 'Cancel', danger: true, destructive: true };
    expect(render(BOOT.w, hedged).html).toBe(render(boot.w, hedged).html);
    boot.dom.window.close();
  });
});
