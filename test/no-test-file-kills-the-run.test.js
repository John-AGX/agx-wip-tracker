/* ────────────────────────────────────────────────────────────────────────
 * NO TEST FILE MAY KILL THE RUN, OR HIDE ITSELF FROM IT.
 *
 * This guard exists because the instrument this repository measures itself
 * with was, for several days, silently deleting its own evidence.
 *
 * THE DEFECT. A handful of files under test/ were hand-rolled node scripts
 * that happened to be NAMED *.test.js. Jest therefore collected them, and
 * each one ended in process.exit(). A process.exit() inside a jest worker
 * does not fail that file — it kills the WORKER:
 *
 *     A jest worker process (pid=19012) crashed for an unknown reason: exitCode=0
 *
 * Jest hands each worker a QUEUE of suites. So the exit did not just erase the
 * exiting file's assertions; it erased every suite still queued behind it on
 * that worker. Which suites those were depended on scheduling, so THE VICTIMS
 * WERE DIFFERENT ON EVERY RUN — attachment-mime (21 tests) one time,
 * save-version-guard (10) the next. That is why three separate audits of this
 * repo produced three different offender counts and three different totals,
 * and why no suite total quoted from this repo before this guard landed can be
 * trusted. Among the suites measured vanishing were four TENANT-BOUNDARY
 * suites: the evidence for the security work was being dropped at random,
 * while the run still printed green.
 *
 * THE SECOND HALF OF THE SAME DISEASE. report-pdf and report-map-bake each
 * defined a local `test()` that SHADOWED jest's global. Jest saw ZERO tests
 * while the file's own console.log printed "all passed" — 19 real assertions
 * were invisible to `npm test`. Shadowing and exiting are one defect wearing
 * two faces: a file that is not honest about who is counting it. Both are
 * checked here, because fixing only the exit leaves the lie intact.
 *
 * THE CURE, WHICH THIS REPO ALREADY WROTE. report-document.test.js,
 * report-document-render.test.js and report-shares.test.js are runnable as
 * plain `node` scripts ON PURPOSE, and stayed that way. Their local test()
 * DELEGATES to jest's global when jest is present, and keeps the script
 * behaviour — exit code included — under bare node:
 *
 *     const UNDER_JEST = typeof global.it === 'function'
 *                     && typeof global.expect === 'function';
 *     function test(name, fn) {
 *       if (UNDER_JEST) return global.it(name, fn);
 *       try { fn(); ... } catch (e) { failures++; ... }
 *     }
 *     ...
 *     if (!UNDER_JEST) { process.exit(failures ? 1 : 0); }
 *
 * Nothing asserted changes. Only who counts it. That is the ONLY sanctioned
 * shape, and this file pins it so a second one cannot be invented.
 *
 * WHY THIS IS AN AST CHECK AND NOT A GREP. Every previous audit of this class
 * was a grep for the string "process.exit", and every one of them was wrong in
 * both directions. It matched `process.exitCode` in plan-census-report.test.js,
 * which is a correct jest suite saving and restoring a global. It matched the
 * header COMMENTS in report-pdf.test.js and report-map-bake.test.js — comments
 * that describe the bug in the past tense, in files where it had already been
 * fixed. And it could not see whether a real call sat inside the guard or
 * outside it, which is the only question that matters. So this parses.
 *
 * @babel/parser is not a declared dependency; it arrives under jest, which is
 * the only context this file runs in. If it is ever missing, this test fails
 * loudly rather than skipping — a source guard that quietly stops looking is
 * the thing it was written to prevent.
 * ──────────────────────────────────────────────────────────────────────── */
'use strict';

const fs = require('fs');
const path = require('path');
const parser = require('@babel/parser');

const TEST_DIR = __dirname;

/* Jest's default testMatch, which is what this project runs on — package.json
 * sets only testPathIgnorePatterns. Kept as the real patterns rather than
 * ".test.js", because `*.spec.cjs` and `__tests__/anything.js` are collected
 * too and would otherwise be a hole. */
function isCollectedByJest(rel) {
  if (/(^|\/)__tests__\//.test(rel)) return /\.[mc]?[jt]sx?$/.test(rel);
  return /\.(test|spec)\.[mc]?[jt]sx?$/.test(rel);
}

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.[mc]?js$/.test(e.name)) out.push(p);
  }
  return out;
}

const FILES = walk(TEST_DIR, []).map((abs) => ({
  abs,
  rel: path.relative(TEST_DIR, abs).split(path.sep).join('/'),
  src: fs.readFileSync(abs, 'utf8')
})).sort((a, b) => a.rel.localeCompare(b.rel));

function parse(f) {
  return parser.parse(f.src, { sourceType: 'unambiguous', allowReturnOutsideFunction: true });
}

/* Depth-first walk carrying the ancestor stack, because every question below is
 * about where a node SITS, not that it exists. */
function visit(node, fn, anc) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const n of node) visit(n, fn, anc); return; }
  if (typeof node.type !== 'string') return;
  fn(node, anc);
  const next = anc.concat([node]);
  for (const k of Object.keys(node)) {
    if (k === 'loc' || k === 'leadingComments' || k === 'trailingComments' || k === 'innerComments') continue;
    visit(node[k], fn, next);
  }
}

function findExits(ast) {
  const hits = [];
  visit(ast.program, (n, anc) => {
    if (n.type !== 'CallExpression') return;
    const c = n.callee;
    if (!c || c.type !== 'MemberExpression' || c.computed) return;
    if (!(c.object && c.object.type === 'Identifier' && c.object.name === 'process')) return;
    if (!(c.property && c.property.type === 'Identifier')) return;
    if (c.property.name !== 'exit' && c.property.name !== 'abort') return;
    hits.push({ line: n.loc.start.line, name: 'process.' + c.property.name, anc: anc });
  }, []);
  return hits;
}

/* The only sanctioned placement: lexically inside `if (!UNDER_JEST) { … }`, or
 * the else-branch of `if (UNDER_JEST) { … } else { … }`. Same statement, same
 * meaning; a reviewer writing the second one is not making a mistake. */
function isGuardedByUnderJest(anc) {
  for (let i = 0; i < anc.length; i++) {
    const n = anc[i];
    if (n.type !== 'IfStatement' || !n.test) continue;
    const t = n.test;
    const child = anc[i + 1];
    if (t.type === 'UnaryExpression' && t.operator === '!'
      && t.argument && t.argument.type === 'Identifier' && t.argument.name === 'UNDER_JEST') {
      if (!child || child !== n.alternate) return true;   // in the consequent
    }
    if (t.type === 'Identifier' && t.name === 'UNDER_JEST' && n.alternate && child === n.alternate) {
      return true;                                        // in the else-branch
    }
  }
  return false;
}

/* A guard is only a guard if UNDER_JEST actually detects jest. `const
 * UNDER_JEST = false` would satisfy every placement rule above and re-arm the
 * whole defect, so the DEFINITION is pinned too: it must typeof-probe jest's
 * own globals. */
function underJestDefinition(ast) {
  let found = null;
  visit(ast.program, (n) => {
    if (n.type !== 'VariableDeclarator') return;
    if (!(n.id && n.id.type === 'Identifier' && n.id.name === 'UNDER_JEST')) return;
    const members = [];
    let typeofs = 0;
    visit(n.init, (m) => {
      if (m.type === 'UnaryExpression' && m.operator === 'typeof') typeofs++;
      if (m.type === 'MemberExpression' && !m.computed
        && m.object && m.object.type === 'Identifier' && m.object.name === 'global'
        && m.property && m.property.type === 'Identifier') members.push(m.property.name);
    }, []);
    found = {
      line: n.loc.start.line,
      probesRunner: members.indexOf('it') >= 0 || members.indexOf('test') >= 0,
      probesExpect: members.indexOf('expect') >= 0,
      typeofs: typeofs
    };
  }, []);
  return found;
}

/* Does a locally-declared test()/it()/describe() hand off to jest? */
function delegatesToJest(ast, name) {
  let delegates = false;
  visit(ast.program, (n) => {
    const isDecl = (n.type === 'FunctionDeclaration' && n.id && n.id.name === name)
      || (n.type === 'VariableDeclarator' && n.id && n.id.type === 'Identifier' && n.id.name === name);
    if (!isDecl) return;
    visit(n, (m) => {
      if (m.type !== 'MemberExpression' || m.computed) return;
      if (!(m.object && m.object.type === 'Identifier' && m.object.name === 'global')) return;
      if (!(m.property && m.property.type === 'Identifier')) return;
      if (['it', 'test', 'describe'].indexOf(m.property.name) >= 0) delegates = true;
    }, []);
  }, []);
  return delegates;
}

function localRunnerDecls(ast) {
  const names = [];
  visit(ast.program, (n) => {
    if (n.type === 'FunctionDeclaration' && n.id && ['test', 'it', 'describe'].indexOf(n.id.name) >= 0) names.push(n.id.name);
    if (n.type === 'VariableDeclarator' && n.id && n.id.type === 'Identifier'
      && ['test', 'it', 'describe'].indexOf(n.id.name) >= 0
      && n.init && /Function/.test(n.init.type)) names.push(n.id.name);
  }, []);
  return Array.from(new Set(names));
}

describe('no test file kills the run, or hides itself from it', () => {

  test('every .js under test/ parses (a file this guard cannot read is a hole)', () => {
    const broken = [];
    for (const f of FILES) { try { parse(f); } catch (e) { broken.push(f.rel + ': ' + e.message); } }
    expect(broken).toEqual([]);
    expect(FILES.length).toBeGreaterThan(100);   // the walk actually found the tree
  });

  /* ── RULE 1 ─────────────────────────────────────────────────────────────
   * A file jest COLLECTS may only force-exit from inside the guard. This is
   * the rule whose absence cost this repo its suite total. */
  test('a collected suite never force-exits outside the UNDER_JEST guard', () => {
    const offenders = [];
    for (const f of FILES) {
      if (!isCollectedByJest(f.rel)) continue;
      const ast = parse(f);
      const exits = findExits(ast);
      if (!exits.length) continue;
      const def = underJestDefinition(ast);
      for (const hit of exits) {
        if (!isGuardedByUnderJest(hit.anc)) {
          offenders.push(f.rel + ':' + hit.line + ' — ' + hit.name
            + '() is not inside `if (!UNDER_JEST)`. It will kill the jest worker and'
            + ' silently delete every suite queued behind it.');
          continue;
        }
        if (!def) {
          offenders.push(f.rel + ':' + hit.line + ' — guarded by an UNDER_JEST that is never defined.');
        } else if (!(def.probesRunner && def.probesExpect && def.typeofs >= 2)) {
          offenders.push(f.rel + ':' + def.line + ' — UNDER_JEST does not detect jest. It must'
            + ' typeof-probe global.it/global.test AND global.expect; anything else re-arms the defect.');
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  /* ── RULE 2 ─────────────────────────────────────────────────────────────
   * The quieter half. A local test() that does not delegate makes the file's
   * assertions invisible while its own output claims success. */
  test('a collected suite that shadows test/it/describe delegates to jest', () => {
    const offenders = [];
    for (const f of FILES) {
      if (!isCollectedByJest(f.rel)) continue;
      const ast = parse(f);
      for (const name of localRunnerDecls(ast)) {
        if (!delegatesToJest(ast, name)) {
          offenders.push(f.rel + ' — declares its own `' + name + '()` and never calls global.'
            + name + '(). Jest will collect this file and count ZERO tests while the file prints'
            + ' its own "all passed".');
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  /* ── RULE 3 ─────────────────────────────────────────────────────────────
   * Helpers and fixtures are not collected, so they may exit freely — but only
   * as long as nothing pulls them into a worker with require(). test/helpers/
   * register2-drive.js is the live example: it calls main() at module scope and
   * exits, which is correct because tenant-register2-http.test.js SPAWNS it as a
   * child process. One require() of it would kill a worker on load. */
  test('an uncollected file that exits is either main-guarded or never required', () => {
    const offenders = [];
    const requiredByTests = new Set();
    for (const f of FILES) {
      const re = /require\(\s*(['"])([^'"]+)\1\s*\)/g;
      let m;
      while ((m = re.exec(f.src))) {
        if (!m[2].startsWith('.')) continue;
        let target = path.resolve(path.dirname(f.abs), m[2]);
        if (!/\.[mc]?js$/.test(target)) target += '.js';
        requiredByTests.add(path.relative(TEST_DIR, target).split(path.sep).join('/'));
      }
    }
    for (const f of FILES) {
      if (isCollectedByJest(f.rel)) continue;
      const ast = parse(f);
      if (!findExits(ast).length) continue;
      const mainGuarded = /require\.main\s*===\s*module/.test(f.src);
      if (mainGuarded) continue;
      if (requiredByTests.has(f.rel)) {
        offenders.push(f.rel + ' — force-exits on load AND is require()d from under test/.'
          + ' Guard its entry with `require.main === module`, or spawn it as a child process.');
      }
    }
    expect(offenders).toEqual([]);
  });

  /* The guard is worth exactly what its detector is worth, so the detector is
   * tested on the real shapes rather than trusted. These are the four bytes an
   * offender is made of. */
  test('the detector actually catches the shapes it claims to', () => {
    const sample = (src) => parser.parse(src, { sourceType: 'unambiguous' });

    const naked = sample('process.exit(1);');
    expect(findExits(naked).length).toBe(1);
    expect(isGuardedByUnderJest(findExits(naked)[0].anc)).toBe(false);

    // The original report-map-bake shape: deferred, and therefore easy to miss.
    const deferred = sample('setTimeout(function(){ process.exit(0); }, 10);');
    expect(findExits(deferred).length).toBe(1);
    expect(isGuardedByUnderJest(findExits(deferred)[0].anc)).toBe(false);

    const guarded = sample('if (!UNDER_JEST) { process.exit(0); }');
    expect(isGuardedByUnderJest(findExits(guarded)[0].anc)).toBe(true);

    // Inverted but equivalent.
    const inverted = sample('if (UNDER_JEST) { run(); } else { process.exit(0); }');
    expect(isGuardedByUnderJest(findExits(inverted)[0].anc)).toBe(true);

    // Placement is right, detection is a lie.
    const lying = sample('const UNDER_JEST = false;\nif (!UNDER_JEST) { process.exit(0); }');
    const d1 = underJestDefinition(lying);
    expect(d1.probesRunner && d1.probesExpect).toBe(false);

    const honest = sample("const UNDER_JEST = typeof global.it === 'function' && typeof global.expect === 'function';");
    const d2 = underJestDefinition(honest);
    expect(d2.probesRunner && d2.probesExpect && d2.typeofs >= 2).toBe(true);

    // Shadowing, both ways round.
    const shadow = sample('function test(n, fn) { try { fn(); } catch (e) {} }');
    expect(localRunnerDecls(shadow)).toEqual(['test']);
    expect(delegatesToJest(shadow, 'test')).toBe(false);
    const delegating = sample('function test(n, fn) { if (UNDER_JEST) return global.it(n, fn); fn(); }');
    expect(delegatesToJest(delegating, 'test')).toBe(true);

    // A grep would call these offenders. They are not.
    expect(findExits(sample('const c = process.exitCode; process.exitCode = 1;')).length).toBe(0);
    expect(findExits(sample('// process.exit(0) is what this used to do\n')).length).toBe(0);
    expect(findExits(sample('const s = "process.exit(0)";')).length).toBe(0);

    // testMatch coverage, including the extensions a grep for ".test.js" misses.
    expect(isCollectedByJest('report-shares.test.js')).toBe(true);
    expect(isCollectedByJest('thing.spec.cjs')).toBe(true);
    expect(isCollectedByJest('__tests__/anything.js')).toBe(true);
    expect(isCollectedByJest('helpers/register2-drive.js')).toBe(false);
    expect(isCollectedByJest('fixtures/tenant-plants.js')).toBe(false);
  });
});
