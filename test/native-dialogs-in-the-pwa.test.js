/**
 * @jest-environment jsdom
 */
// A BUTTON THAT DOES NOTHING AND SAYS NOTHING.
//
// window.prompt / confirm / alert ARE NO-OPS IN AN INSTALLED PWA. They do not
// throw, they do not warn, they return undefined. That is not a cosmetic
// failure, because of the shape of the guard every caller writes:
//
//     var name = window.prompt('Name this view:', '');
//     if (name == null) return;
//
// `undefined == null` is TRUE. So on John's phone the guard fired, the dialog
// never appeared, nothing was named, nothing was created, and NOTHING SAID SO.
// Cost Inbox's "Save view" was that button. Two confirm() calls three lines
// above it had already been fixed by hand and this one was missed, because a
// sweep for `confirm(` does not find `prompt(` and a person doing it by eye
// stops at the end of the function they came for.
//
// THIS FILE HAS TWO JOBS AND THEY ARE DIFFERENT JOBS.
//
//   1. EXECUTE the fix. Load the shipped dialog helper in a DOM, run the
//      shipped wrapper against it, and prove a real dialog is rendered and a
//      real value comes back. A test that greps cost-inbox.js for the string
//      "p86Prompt" would pass against a call that was never reachable.
//
//   2. PIN THE CLASS. 496 native calls survive in js/ — 410 alert(), 54
//      prompt(), 32 confirm(), across 46 files. They cannot all be fixed in
//      this commit, and a guard
//      that goes red on all of them would be turned off within the day. So the
//      inventory is written down per file per kind, and a change to it is a
//      decision somebody makes on purpose. Adding a native prompt to a file
//      turns this red. Fixing one turns it red too, until the number beside
//      the file is lowered in the same commit — which is exactly the moment
//      the next person notices the other one three lines away.
//
// COUNTS, NOT LINE NUMBERS. Two or three sessions push to this repo at once
// and line numbers move under every one of them. A count moves only when a
// native dialog is genuinely added or removed.

const fs = require('fs');
const path = require('path');
const parser = require('@babel/parser');

const ROOT = path.join(__dirname, '..');
const JS_DIR = path.join(ROOT, 'js');
const lf = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n?/g, '\n');

// ────────────────────────────────────────────────────────────────────────
// 1. THE FIX, EXECUTED
// ────────────────────────────────────────────────────────────────────────

// Lift a named function out of a shipped file, braces balanced, so the thing
// under test is the thing that ships. Same idiom as
// test/receipt-store-phone-render.test.js, and for the same reason: a copy of
// the helper in here would keep passing after the shipped one regressed.
function lift(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('no function ' + name + ' in that file any more');
  let depth = 0;
  let started = false;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    if (src[k] === '{') { depth++; started = true; } else if (src[k] === '}') {
      depth--;
      if (started && depth === 0) return src.slice(i, k + 1);
    }
  }
  throw new Error('unbalanced braces lifting ' + name);
}

const COST_INBOX = lf(path.join(JS_DIR, 'cost-inbox.js'));
const DIALOGS = lf(path.join(JS_DIR, 'dialogs.js'));
const INDEX_HTML = lf(path.join(ROOT, 'index.html'));

describe('the in-app prompt exists, and it is not a plan — it is loaded', () => {
  test('js/dialogs.js defines window.p86Prompt unconditionally', () => {
    // The claim that stopped this being fixed the first time was "there is no
    // in-app prompt helper to route to; it needs a control built". There is
    // one, it is exported at the top level of an IIFE with no feature test in
    // front of it, and it has been there the whole time.
    expect(DIALOGS).toContain('window.p86Prompt = p86Prompt;');
    const assign = DIALOGS.indexOf('window.p86Prompt = p86Prompt;');
    const fnStart = DIALOGS.indexOf('function p86Prompt(');
    expect(fnStart).toBeGreaterThan(0);
    expect(assign).toBeGreaterThan(fnStart);
  });

  test('index.html loads dialogs.js BEFORE cost-inbox.js', () => {
    // Order is the whole of the availability question for a global. If this
    // ever inverts, the wrapper silently takes its native fallback and the
    // button goes quiet again on the phone with nothing failing anywhere.
    const d = INDEX_HTML.indexOf('js/dialogs.js?v=');
    const c = INDEX_HTML.indexOf('js/cost-inbox.js?v=');
    expect(d).toBeGreaterThan(0);
    expect(c).toBeGreaterThan(0);
    expect(d).toBeLessThan(c);
  });
});

describe('p86Prompt actually renders a dialog and actually returns the value', () => {
  let restore;
  beforeEach(() => {
    document.body.innerHTML = '';
    // The shipped file, evaluated. Not a description of it.
    // eslint-disable-next-line no-new-func
    new Function('window', 'document', DIALOGS)(window, document);
    restore = window.p86Prompt;
  });

  test('it is defined after the file runs', () => {
    expect(typeof restore).toBe('function');
  });

  test('typing a name and pressing OK resolves with that name', async () => {
    const p = window.p86Prompt({ title: 'Save view', message: 'Name this view:' });
    const input = document.querySelector('[data-p86-input]');
    expect(input).not.toBeNull();               // a real control, in the real DOM
    input.value = 'Unpaid, this month';
    document.querySelector('[data-p86-primary]').click();
    await expect(p).resolves.toBe('Unpaid, this month');
  });

  test('cancel resolves null — the value every caller checks for', async () => {
    const p = window.p86Prompt({ title: 'Save view' });
    document.querySelector('[data-p86-cancel]').click();
    await expect(p).resolves.toBeNull();
  });

  test('it renders the title and message it was given', async () => {
    const p = window.p86Prompt({ title: 'Save view', message: 'Name this view:' });
    expect(document.body.textContent).toContain('Save view');
    expect(document.body.textContent).toContain('Name this view:');
    // Closed before the test ends. An open dialog leaves a document-level
    // keydown listener and an unsettled promise behind, and jest reports that
    // as a worker failing to exit gracefully — in a repo where a worker dying
    // silently deletes whatever suite it shared.
    document.querySelector('[data-p86-cancel]').click();
    await p;
  });
});

describe("Cost Inbox's Save view now goes through it", () => {
  test('p86Text routes to window.p86Prompt when it is there', async () => {
    const seen = [];
    window.p86Prompt = (o) => { seen.push(o); return Promise.resolve('Weekly fuel'); };
    // eslint-disable-next-line no-new-func
    const p86Text = new Function('window', lift(COST_INBOX, 'p86Text') + '; return p86Text;')(window);
    await expect(p86Text('Name this view:', { title: 'Save view' })).resolves.toBe('Weekly fuel');
    expect(seen).toHaveLength(1);
    expect(seen[0].title).toBe('Save view');
    // defaultValue is the key p86Prompt actually reads. Passing `value` and
    // not `defaultValue` would put an empty box on screen and look fine here.
    expect(seen[0]).toHaveProperty('defaultValue');
    expect(seen[0].message).toBe('Name this view:');
  });

  test('it still works standalone, where there is no in-app dialog', async () => {
    // These files are opened outside the app on purpose. The native call is
    // kept as the fallback, not deleted.
    delete window.p86Prompt;
    window.prompt = () => 'typed natively';
    // eslint-disable-next-line no-new-func
    const p86Text = new Function('window', lift(COST_INBOX, 'p86Text') + '; return p86Text;')(window);
    await expect(p86Text('Name this view:')).resolves.toBe('typed natively');
  });

  test('the Save view handler awaits the wrapper and never calls prompt itself', () => {
    const i = COST_INBOX.indexOf("pop.querySelector('#ciSaveView')");
    expect(i).toBeGreaterThan(0);
    const handler = COST_INBOX.slice(i, i + 900);
    expect(handler).toContain('await p86Text(');
    expect(handler).not.toContain('window.prompt(');
    // `if (name == null) return` is kept, and it is now correct: p86Prompt
    // resolves null on cancel. The bug was never the guard — it was that
    // undefined satisfied it when no dialog had been shown at all.
    expect(handler).toContain('if (name == null) return;');
  });

  test('cost-inbox.js has no native prompt left outside the fallback', () => {
    const outside = COST_INBOX.split(lift(COST_INBOX, 'p86Text')).join('');
    expect(outside).not.toContain('window.prompt(');
  });
});

// ────────────────────────────────────────────────────────────────────────
// 2. THE CLASS
// ────────────────────────────────────────────────────────────────────────

// AST, not grep. Grep for `confirm(` matches `p86Confirm(`, matches the word
// in a comment, matches it inside a string, and cannot tell a call that
// reaches a user from the documented native fallback at the tail of a wrapper.
// Every one of those mistakes has already been made on this class.
const NAMES = new Set(['alert', 'confirm', 'prompt']);

function census() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); continue; }
      if (!e.name.endsWith('.js')) continue;
      const src = lf(p);
      const rel = path.relative(ROOT, p).replace(/\\/g, '/');
      let ast;
      try {
        ast = parser.parse(src, { sourceType: 'unambiguous', errorRecovery: true });
      } catch (err) {
        throw new Error(rel + ' does not parse: ' + err.message);
      }
      const stack = [];
      const visit = (node) => {
        if (!node || typeof node.type !== 'string') return;
        const isFn = /Function(Declaration|Expression)$/.test(node.type)
          || node.type === 'ArrowFunctionExpression';
        if (isFn) stack.push(node);
        if (node.type === 'CallExpression') {
          const c = node.callee;
          let name = null;
          if (c.type === 'Identifier' && NAMES.has(c.name)) name = c.name;
          else if (c.type === 'MemberExpression' && c.object.type === 'Identifier'
                   && ['window', 'globalThis', 'self'].includes(c.object.name)) {
            if (!c.computed && c.property.type === 'Identifier' && NAMES.has(c.property.name)) {
              name = c.property.name;
            } else if (c.computed && c.property.type === 'StringLiteral'
                       && NAMES.has(c.property.value)) {
              name = c.property.value;
            }
          }
          if (name) {
            // THE ONE ACCEPTED SHAPE: the native call is the last resort inside
            // a function that prefers the in-app dialog. p86Ask and p86Text in
            // cost-inbox.js, askText and askYesNo in purchase-order-editor.js
            // and the five sites in estimate-editor.js are all this shape, and
            // none of them reaches a user in the installed app.
            const fn = stack[stack.length - 1];
            const guarded = !!fn
              && /window\.p86(Confirm|ConfirmTernary|Alert|Prompt)\b/.test(src.slice(fn.start, fn.end));
            if (!guarded) out.push({ file: rel, name, line: node.loc.start.line });
          }
        }
        for (const k of Object.keys(node)) {
          if (k === 'loc' || /Comments$/.test(k)) continue;
          const v = node[k];
          if (Array.isArray(v)) { for (const n of v) if (n && typeof n.type === 'string') visit(n); }
          else if (v && typeof v.type === 'string') visit(v);
        }
        if (isFn) stack.pop();
      };
      visit(ast.program);
    }
  };
  walk(JS_DIR);
  const by = {};
  for (const h of out) {
    by[h.file] = by[h.file] || { alert: 0, confirm: 0, prompt: 0 };
    by[h.file][h.name]++;
  }
  return by;
}

// THE INVENTORY. Every native dialog under js/ that reaches a user, as of
// this commit. `p` and `c` are the ones that BREAK A FEATURE — their return
// value drives control flow, and undefined silently takes the cancel branch.
// `a` is an alert: a message that is simply never shown, which loses an error
// report but does not make a button lie.
//
// TO CHANGE A NUMBER HERE YOU HAVE TO HAVE LOOKED AT THE FILE. That is the
// point. Route the call through window.p86Confirm / p86Alert / p86Prompt and
// lower the number in the same commit.
const INVENTORY = {
  'js/account.js': { a: 3 },
  'js/actas.js': { a: 1 },
  'js/admin-context-registry.js': { a: 2 },
  'js/admin.js': { a: 100, c: 5, p: 15 },
  'js/ai-panel.js': { a: 10, p: 1 },
  'js/app.js': { a: 1, p: 2 },
  'js/attachments.js': { a: 15, c: 2 },
  'js/bt-export.js': { a: 2 },
  'js/change-order-editor.js': { a: 12 },
  'js/clients.js': { a: 12 },
  'js/compliance-review-ui.js': { a: 5 },
  'js/console.js': { c: 1 },
  'js/doc-import.js': { a: 2, c: 1 },
  'js/email-block-editor.js': { c: 2, p: 1 },
  'js/email-hub.js': { a: 1, c: 1, p: 5 },
  'js/estimate-editor.js': { a: 14 },
  'js/estimate-preview.js': { a: 4 },
  'js/estimates.js': { a: 5, p: 2 },
  'js/field-tools.js': { a: 8 },
  'js/job-audit.js': { a: 1 },
  'js/job-costs-import.js': { a: 5 },
  'js/job-reports.js': { a: 5, p: 1 },
  'js/job-workflow-ui.js': { a: 4 },
  'js/jobs-hub.js': { a: 14, c: 1, p: 1 },
  'js/jobs.js': { a: 12, p: 1 },
  'js/leads.js': { a: 16, p: 2 },
  'js/live-rooms.js': { p: 2 },
  'js/markup-viewer.js': { a: 15, c: 2, p: 1 },
  'js/materials-drawer.js': { a: 3 },
  'js/messaging.js': { a: 1 },
  'js/my-files.js': { a: 9, c: 1, p: 1 },
  'js/nodegraph.js': { p: 1 },
  'js/pdf-viewer.js': { a: 4 },
  'js/plans.js': { c: 1 },
  'js/projects-pairs.js': { c: 1 },
  'js/projects.js': { a: 27, c: 8, p: 2 },
  'js/proposal.js': { a: 7 },
  'js/purchase-order-editor.js': { a: 12, c: 1, p: 3 },
  'js/qb-costs-view.js': { a: 11 },
  'js/rich-text.js': { p: 1 },
  'js/schedule.js': { a: 3 },
  'js/sheet-editor.js': { a: 18, c: 2, p: 4 },
  'js/subs.js': { a: 18, c: 2, p: 1 },
  'js/voice-input.js': { a: 1 },
  'js/workspace-layout.js': { a: 1 },
  'js/workspace.js': { a: 26, c: 1, p: 7 },
};

describe('no native dialog is added to the client without somebody noticing', () => {
  const found = census();
  const expand = (v) => ({ alert: v.a || 0, confirm: v.c || 0, prompt: v.p || 0 });

  test('cost-inbox.js is clean — the file this commit is about', () => {
    expect(found['js/cost-inbox.js']).toBeUndefined();
  });

  test('every file with a native dialog is in the inventory', () => {
    const unlisted = Object.keys(found).filter((f) => !(f in INVENTORY)).sort();
    expect(unlisted).toEqual([]);
  });

  test('and every file in the inventory still has exactly what it says', () => {
    const drift = {};
    for (const [file, want] of Object.entries(INVENTORY)) {
      const got = found[file] || { alert: 0, confirm: 0, prompt: 0 };
      const w = expand(want);
      if (got.alert !== w.alert || got.confirm !== w.confirm || got.prompt !== w.prompt) {
        drift[file] = { inventory: w, actual: got };
      }
    }
    expect(drift).toEqual({});
  });

  test('the detector sees through the spellings a grep would miss', () => {
    // Written down because every previous attempt at this class was a grep,
    // and each of these is a real way to write the same defect.
    const shapes = [
      "window['prompt']('x')",
      'globalThis.confirm("x")',
      'self.alert("x")',
      'window.prompt("x")',
      'confirm("x")',
    ];
    for (const s of shapes) {
      const ast = parser.parse(s, { sourceType: 'unambiguous' });
      const call = ast.program.body[0].expression;
      const c = call.callee;
      const hit = (c.type === 'Identifier' && NAMES.has(c.name))
        || (c.type === 'MemberExpression' && c.object.type === 'Identifier'
            && ['window', 'globalThis', 'self'].includes(c.object.name)
            && NAMES.has(c.computed ? c.property.value : c.property.name));
      expect({ shape: s, detected: hit }).toEqual({ shape: s, detected: true });
    }
  });

  test('and it does NOT count the documented fallback inside a wrapper', () => {
    // p86Ask's own `return Promise.resolve(window.confirm(message))` is not a
    // defect: it is unreachable in the app, and deleting it would break these
    // files run standalone. Counting it would make the inventory noise.
    expect(COST_INBOX).toContain('return Promise.resolve(window.confirm(message));');
    expect(found['js/cost-inbox.js']).toBeUndefined();
  });
});

describe('what the inventory is telling us, stated so it is not lost', () => {
  const found = census();
  const total = (k) => Object.values(found).reduce((s, v) => s + v[k], 0);

  test('prompt() and confirm() are the ones that break a feature', () => {
    // Their return value is the control flow. undefined takes the cancel
    // branch, so the button does nothing AND SAYS NOTHING. Every one of these
    // is a "Save view" waiting to be found on somebody's phone.
    expect(total('prompt') + total('confirm')).toBeGreaterThan(0);
    expect(total('prompt') + total('confirm')).toBeLessThanOrEqual(86);
  });

  test('alert() loses a message, which is different and still bad', () => {
    // Almost all of these are `.catch(e => alert('Save failed: ' + e))`. In the
    // installed app the save fails and the screen says nothing at all.
    expect(total('alert')).toBeLessThanOrEqual(410);
  });
});
