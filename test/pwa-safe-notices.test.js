// test/pwa-safe-notices.test.js — a refusal the user can actually hear.
//
// Native alert() / confirm() / prompt() are NO-OPS in the installed PWA.
// That is a documented repo-wide class, and it has already cost a silent
// task delete and a purchase-order approval that recorded a signature
// with no name on it.
//
// In the Materials Drawer it meant this: the unpriced-assembly hard stop
// — added deliberately to mirror the server's `assembly_unpriced` refusal
// so the one door a human uses could not append an understated cost —
// REFUSED the insert and then said nothing at all. The Add button simply
// looked broken. js/assemblies.js had the same shape, and worse: its
// delete confirm was called positionally, so it rendered an empty box and
// never ran the delete at all, which made its two refusal notices dead
// code in the app.
//
// Both files already carried a PWA-safe helper and then bypassed it. So
// this pins the helper's shape, pins the reachable sites, and COUNTS what
// is deliberately left raw — a count is what stops the next one sneaking
// back in.

const fs = require('fs');
const path = require('path');
const raw = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8')
  .replace(/\r\n/g, '\n');
const D = raw('js', 'materials-drawer.js');
const A = raw('js', 'assemblies.js');

// Lines that actually CALL a native dialog. A comment line discussing
// alert() is not a call, and p86Alert / p86Confirm are not native (the
// regex is case-sensitive, so the p86* names cannot match).
const nativeCalls = (src) => src.split('\n')
  .filter((l) => !l.trim().startsWith('//'))
  .filter((l) => /(^|[^.\w])(alert|confirm|prompt)\s*\(/.test(l));

// The body of a top-level function in one of these IIFE files.
const fnBody = (src, decl) => {
  const from = src.slice(src.indexOf(decl));
  return from.slice(0, from.indexOf('\n  }\n'));
};

describe('the PWA-safe helper is the right primitive, not just present', () => {
  test.each([
    ['js/materials-drawer.js', D, 'function mdNotify('],
    ['js/assemblies.js', A, 'function notify('],
  ])('%s reaches for p86Alert before anything else', (_name, src, decl) => {
    const body = fnBody(src, decl);
    expect(body).toMatch(/typeof window\.p86Alert === 'function'/);
    // p86Alert is the SINGLE-button primitive. p86Confirm draws a Cancel
    // beside OK for a message there is nothing to cancel, so it may only
    // be a fallback — p86Alert has to be tried first.
    expect(body.indexOf('p86Alert')).toBeGreaterThan(-1);
    expect(body.indexOf('p86Alert')).toBeLessThan(body.indexOf('p86Confirm'));
    // The two live p86Confirm implementations disagree on option names —
    // js/app.js reads confirmText, js/dialogs.js reads confirmLabel — so
    // the old `confirmText: 'OK'` was honoured by one and ignored by the
    // other, depending purely on load order. p86Alert sidesteps it, and
    // the divergent key is gone.
    expect(body).not.toMatch(/confirmText/);
    // alert() survives ONLY as the tail: a fallback that is itself a
    // no-op in the PWA is not a fallback, so it must never be the path
    // the installed app takes.
    expect(body.lastIndexOf('alert(msg)')).toBeGreaterThan(body.indexOf('p86Confirm'));
  });
});

describe('every reachable refusal and failure in the drawer is audible', () => {
  test('THE named defect: the unpriced-assembly hard stop speaks', () => {
    // A badge is not a guard, and a guard nobody can hear is not one
    // either. The message and the return both still stand.
    expect(D).toMatch(/mdNotify\('Priced this recipe before adding it/);
    expect(D).not.toMatch(/alert\('Priced this recipe before adding it/);
  });

  test.each([
    ["a stack with no takeoff qty", /mdNotify\('Give each stacked assembly a takeoff qty first\.'\)/],
    ["saving a stack with no name", /mdNotify\('Name the new assembly first\.'\)/],
    ["the POST /api/assemblies failure", /mdNotify\('Save failed: /],
    ["a bulk add missing quantities", /mdNotify\(missingQty \+ ' line\(s\) need a qty before adding\.'/],
    ["the bulk-add target throwing", /mdNotify\('Bulk add failed: /],
  ])('%s', (_label, re) => { expect(D).toMatch(re); });
});

describe('deleting an assembly both works and speaks', () => {
  test('the confirm passes an OPTIONS OBJECT and awaits its answer', () => {
    // It was p86Confirm(msg, doDelete) — positional. Every p86Confirm
    // implementation takes an options object and returns a
    // Promise<boolean>, so `opts` was a string: opts.message came out
    // undefined and the dialog body rendered EMPTY, while doDelete sat in
    // a second argument nothing reads. Wherever p86Confirm exists — which
    // is always, in the app — deleting an assembly showed a blank box and
    // then did nothing.
    const body = fnBody(A, 'function remove(id)');
    expect(body).not.toMatch(/p86Confirm\(\s*'/);      // never positional again
    expect(body).toMatch(/p86Confirm\(\{/);            // options object
    expect(body).toMatch(/if \(ok\) doDelete\(\)/);    // and the answer is USED
    // Both option-name families, so the answer does not depend on which
    // implementation load order selected.
    expect(body).toMatch(/confirmText: 'Delete', confirmLabel: 'Delete'/);
    expect(body).toMatch(/destructive: true, danger: true/);
  });

  test('the server refusing a delete is heard, not swallowed', () => {
    const body = fnBody(A, 'function remove(id)');
    expect(body).toMatch(/notify\(res\.error, 'Delete refused'\)/);
    expect(body).toMatch(/notify\('Delete failed: /);
    // No raw CALL left in here — the comments still discuss alert(), so
    // strip comment lines rather than matching the prose.
    expect(nativeCalls(body).filter((l) => /alert\(/.test(l))).toHaveLength(0);
  });
});

// ── The property: what is LEFT raw, and why ─────────────────────────
// Counting is the part that survives the next edit. Route one more
// refusal through alert() in either file and one of these goes red.
describe('the only native dialogs left are the documented exempt ones', () => {
  test('js/materials-drawer.js keeps exactly four', () => {
    const calls = nativeCalls(D);
    // Three are the SAME developer guard, in insertStack / submitAdd /
    // submitBulkAdd. targetApi() returns
    // window.p86ActiveLineTarget || window.estimateEditorAPI;
    // estimate-editor.js assigns estimateEditorAPI unconditionally at
    // load (before this file) carrying applyAddLineItem AND
    // applyBulkAddLineItems, and coLineTarget — the only value
    // p86ActiveLineTarget is ever assigned, in js/change-order-editor.js
    // — carries both too. So the guard can fire only if
    // estimate-editor.js failed to PARSE, and then the app is already
    // broken and a plain alert is the more honest signal.
    expect(calls.filter((l) => /Estimate editor isn/.test(l))).toHaveLength(3);
    // The fourth is the helper's own last resort, for a plain browser
    // that loaded neither p86Alert nor p86Confirm.
    expect(calls.filter((l) => /^\s*alert\(msg\);\s*$/.test(l))).toHaveLength(1);
    expect(calls).toHaveLength(4);
  });

  test('js/assemblies.js keeps exactly two', () => {
    const calls = nativeCalls(A);
    // The helper's last resort, and remove()'s confirm() fallback — which
    // runs only when window.p86Confirm is absent, i.e. never in the app.
    expect(calls.filter((l) => /^\s*alert\(msg\);\s*$/.test(l))).toHaveLength(1);
    expect(calls.filter((l) => /else if \(confirm\(msg\)\)/.test(l))).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });
});
