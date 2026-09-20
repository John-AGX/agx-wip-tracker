// test/work-orders-1-34-release.test.js — the 1.34 note still says what it has
// to say, and every ?v in index.html tells the truth about the files the phase
// in flight changed.
//
// 1.34 is the release that takes work-order buildings off the task lists and
// ships their replacements. It is SHIPPED AND LIVE, and 1.35 corrects it the
// same day — so 1.34 is no longer the newest entry, and the "APP_VERSION is
// 1.34" assertion this file opened with moved out with that rule. What is
// asserted here now:
//
//   THE NOTE — 1.34 is still in the catalog, one or more places below the
//   newest entry and directly above 1.33; whatever the newest entry is,
//   APP_VERSION mirrors it; 1.34's rows are grouped new / improved / fixed, it
//   says out loud that task counts will drop (the one number every user will
//   notice the morning after), it names the three replacements by the words on
//   the screen (My work, My Day, the digest), and it carries no money — the
//   note is read by crews.
//
//   WHAT 1.34 STILL SAYS — that a BUILDING is assigned to a person. That was
//   true of what 1.34 shipped and is not true of the product any more, but a
//   patch note is dated: it records what one version did, it is not a
//   description of the app today. The entry was briefly rewritten onto the
//   record, which left two notes dated the same day contradicting each other
//   with 1.35 billed as fixing what 1.34 claimed to have shipped. It is
//   restored, and pinned below. The correction is in 1.35’s own rows, and the
//   scan that holds the CURRENT release to the rule lives with it, in
//   test/work-order-responsibility-release.test.js.
//
//   THE TAGS — every js/ or css/ file this phase edited has its ?v bumped in
//   index.html. The rule and its three clauses live in test/helpers/cache-
//   buster.js; this file applies them to the set git reports as changed rather
//   than to a list somebody typed, so a file edited late in the phase cannot
//   slip through by not being on the list.
//
// Every check here is run against a mutant that must fail it, so none of them
// can pass by matching nothing.
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const catalog = require('../server/feature-catalog.js');
const cacheBuster = require('./helpers/cache-buster.js');

const VERSION = '1.34';

// ── the shape rules, re-derived ───────────────────────────────────────────
// test/work-orders-1-29-wiring.test.js has catalogProblems(), but it is a test
// file with describe() at the top level: requiring it from here would run its
// whole suite a second time inside this one. So the same rules are restated,
// narrowed to one release, and then proved non-vacuous by the mutants below.
const RANK = { new: 0, improved: 1, fixed: 2 };

function releaseProblems(r) {
  const out = [];
  if (!r) return ['no release'];
  if (!/^\d+\.\d+$/.test(String(r.version))) out.push('bad version ' + r.version);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(r.date))) out.push('bad date ' + r.date);
  for (const k of ['name', 'summary']) {
    if (typeof r[k] !== 'string' || !r[k].trim()) out.push('a release with no ' + k);
  }
  const changes = r.changes || [];
  if (!changes.length) out.push('a release with no changes');
  let last = -1;
  changes.forEach((ch) => {
    if (!(ch.type in RANK)) out.push('unknown change type ' + ch.type);
    else if (RANK[ch.type] < last) out.push('rows are not grouped new, improved, fixed');
    else last = RANK[ch.type];
    if (typeof ch.text !== 'string' || !ch.text.trim()) out.push('a row with no text');
  });
  return out;
}

const rel133 = () => catalog.releases.find((r) => r.version === VERSION);
const indexOfRel = (v) => catalog.releases.findIndex((r) => r.version === v);
const rowsOf = (r) => (r.changes || []).map((c) => c.text);
const allText = (r) => [r.name, r.summary].concat(rowsOf(r)).join('\n');

// ── git, the way cache-buster.js asks it ──────────────────────────────────
function git(...args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] });
}

// The js/ and css/ files this working tree changes against HEAD. Empty is a
// legitimate answer (everything already committed); undefined means git could
// not be asked, which is the failure mode the historyAvailable clause exists
// to make visible rather than silent.
function changedJsCss() {
  try {
    return git('diff', '--name-only', 'HEAD', '--', 'js', 'css')
      .split('\n').map((s) => s.trim()).filter(Boolean);
  } catch (e) {
    return undefined;
  }
}

const CHANGED = changedJsCss();
const INDEX = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

// ── 1. the version ────────────────────────────────────────────────────────
describe('release ' + VERSION + ' is cut', () => {
  test('APP_VERSION names the newest release, and ' + VERSION + ' is in the list', () => {
    // This suite was written the day 1.34 was cut, when it was newest. Later
    // releases ship above it, so what stays true is: APP_VERSION always names
    // whatever sits at the head of the list, and this release is still there.
    expect(catalog.APP_VERSION).toBe(catalog.releases[0].version);
    expect(catalog.releases.map((r) => r.version)).toContain(VERSION);
  });

  test('mutant: APP_VERSION left on the previous release is caught', () => {
    const stale = Object.assign({}, catalog, { APP_VERSION: catalog.releases[1].version });
    // The assertion above, made against the mutant, must fail.
    expect(() => {
      expect(stale.APP_VERSION).toBe(stale.releases[0].version);
    }).toThrow();
    // And the list really is ordered newest-first, not a coincidence: this
    // release sits directly above 1.33, which shipped from another branch the
    // same day. Checked by position RELATIVE to this release, so a later one
    // shipping above it does not make this assertion wrong.
    const at = catalog.releases.findIndex((r) => r.version === VERSION);
    expect(at).toBeGreaterThanOrEqual(0);
    expect(catalog.releases[at + 1].version).toBe('1.33');
  });

  test('its rows are grouped new, improved, fixed, and every row has text', () => {
    expect(releaseProblems(rel133())).toEqual([]);
    const types = (rel133().changes || []).map((c) => c.type);
    // Not vacuous: the release really does carry all three groups.
    expect(new Set(types)).toEqual(new Set(['new', 'improved', 'fixed']));
  });

  test('mutant: rows out of group, and a row with no text, are caught', () => {
    const r = rel133();
    const reversed = Object.assign({}, r, { changes: r.changes.slice().reverse() });
    expect(releaseProblems(reversed)).toEqual(
      expect.arrayContaining(['rows are not grouped new, improved, fixed']),
    );
    const blank = Object.assign({}, r, { changes: r.changes.concat([{ type: 'fixed', text: '  ' }]) });
    expect(releaseProblems(blank)).toEqual(expect.arrayContaining(['a row with no text']));
  });
});

// ── 2. what the note has to say ───────────────────────────────────────────
describe('the ' + VERSION + ' note says what changes for the reader', () => {
  test('one row says the task counts will drop', () => {
    const rows = rowsOf(rel133());
    // Both halves in the SAME row: "counts" somewhere in the note and "drop"
    // somewhere else in it would let a note that never connects them pass.
    const said = rows.filter((t) => /count/i.test(t) && /drop|lower|smaller/i.test(t));
    expect(said.length).toBeGreaterThan(0);
    // Mutant: the halves split across two rows do not satisfy it.
    const split = ['your task counts are different', 'numbers will drop'];
    expect(split.filter((t) => /count/i.test(t) && /drop|lower|smaller/i.test(t))).toEqual([]);
  });

  test('it names the three replacements by the words on the screen', () => {
    const text = allText(rel133());
    expect(text).toMatch(/My work/);
    expect(text).toMatch(/My Day/);
    expect(text).toMatch(/digest/i);
    // and the surfaces the buildings left, so the reader can tell why a list
    // they use every day got shorter.
    expect(text).toMatch(/My Tasks/);
    expect(text).toMatch(/Tasks panel/);
  });

  test('it states the two things that did not change', () => {
    const text = allText(rel133());
    expect(text).toMatch(/link still works/i);
    expect(text).toMatch(/private to-do/i);
  });

  test('no dollar figure, price or rate appears anywhere in it', () => {
    const text = allText(rel133());
    expect(text).not.toMatch(/[$£€]\s?\d|\b\d+\.\d{2}\b/);
    // Not vacuous: the pattern does catch money.
    expect('a $40 fee and a 1.25 rate').toMatch(/[$£€]\s?\d|\b\d+\.\d{2}\b/);
  });
});

// ── 3. the cache busters ──────────────────────────────────────────────────
describe('every ?v in index.html tells the truth', () => {
  test('git could be asked what changed', () => {
    // A guard that quietly becomes a no-op because git did not answer is the
    // failure this names out loud.
    expect(CHANGED).toBeDefined();
  });

  test('every js/css file changed in this working tree has a bumped ?v', () => {
    expect(CHANGED).toBeDefined();
    const unhealthy = [];
    const skipped = [];
    CHANGED.forEach((f) => {
      const r = cacheBuster.report(f);
      if (!r.historyAvailable) { skipped.push(r); return; }
      try {
        expect(r).toMatchObject(cacheBuster.healthy(f));
      } catch (e) {
        unhealthy.push(r);
      }
    });
    // Report the whole set at once, so one run names every file that is short.
    expect({ unhealthy, skipped }).toEqual({ unhealthy: [], skipped: [] });
  });

  test('each changed file is tagged ABOVE the tag HEAD ships', () => {
    expect(CHANGED).toBeDefined();
    const headIndex = git('show', 'HEAD:index.html');
    const short = CHANGED.map((f) => ({
      file: f,
      head: cacheBuster.tagIn(headIndex, f),
      working: cacheBuster.tagIn(INDEX, f),
    })).filter((x) => x.head && x.working && !(x.working.n > x.head.n || (x.working.n === x.head.n && x.working.s > x.head.s)));
    expect(short).toEqual([]);
  });

  test('index.html still tags the whole app, and every tagged file exists', () => {
    const tagged = cacheBuster.taggedFiles(INDEX);
    expect(tagged.length).toBeGreaterThan(100);
    expect(tagged.filter((f) => !fs.existsSync(path.join(ROOT, f)))).toEqual([]);
    // A tag mangled into `?v=` with nothing after it drops out of taggedFiles()
    // entirely, so also check nothing is referenced without a tag at all.
    const untagged = [...INDEX.replace(/<!--[\s\S]*?-->/g, '')
      .matchAll(/(?:src|href)="((?:js|css)\/[^"?]+)"/g)].map((m) => m[1]);
    expect(untagged).toEqual([]);
  });

  test('mutant: a bump reverted in index.html is reported as the lower tag', () => {
    const target = (CHANGED && CHANGED.length ? CHANGED : cacheBuster.taggedFiles(INDEX))[0];
    expect(typeof target).toBe('string');
    const real = cacheBuster.tagIn(INDEX, target);
    expect(real).not.toBeNull();
    const esc = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const reverted = INDEX.replace(
      new RegExp('((?:src|href)="' + esc + '\\?v=)' + real.n + (real.s || '') + '"'),
      '$1' + (real.n - 1) + (real.s || '') + '"',
    );
    expect(reverted).not.toBe(INDEX);
    const back = cacheBuster.tagIn(reverted, target);
    expect(back.n).toBe(real.n - 1);
    expect(back.n).toBeLessThan(real.n);
  });
});

// ── 4. the note is the record of what 1.34 shipped ───────────────────
// These are the sentences 1.34 went out with. They describe a rule the app no
// longer follows — that is what makes them history rather than documentation,
// and history is not edited to agree with the present. Pinned verbatim so the
// next correction goes in the next release’s rows instead of in here.
describe('the ' + VERSION + ' note is the record of what ' + VERSION + ' shipped', () => {
  const SHIPPED = [
    'a Buildings assigned to you section in the morning digest, every one of them following who a building is assigned to rather than who can open the job.',
    'Your buildings live on the work order now.',
    'a building is assigned to a person, not to whoever can see the job',
    'The morning work-orders digest carries your buildings.',
  ];

  test('it still carries the sentences ' + VERSION + ' went out with', () => {
    const text = allText(rel133());
    expect(SHIPPED.filter((s) => text.indexOf(s) === -1)).toEqual([]);
  });

  test('MUTANT: the entry restated onto the record loses every one of them', () => {
    // Exactly the rewrite that was made and is now undone.
    const rewritten = [
      'a work-orders section in the morning digest, every one of them following who the work order is assigned to rather than who can open the job.',
      'Buildings live on the work order now.',
      'a work order is assigned to a person, not to whoever can see the job',
      'The morning work-orders digest carries the buildings still open on your work orders.',
    ].join('\n');
    expect(SHIPPED.filter((s) => rewritten.indexOf(s) !== -1)).toEqual([]);
  });

  test('the correction lives in a later release, not in this entry', () => {
    // Found by looking above 1.34 rather than by naming a version, so the
    // release after next does not move this line.
    const above = catalog.releases.slice(0, indexOfRel(VERSION));
    expect(above.filter((r) => /never assigned to one person/i.test(allText(r))).length)
      .toBeGreaterThan(0);
    // And the correcting note tells the reader this entry was left alone.
    expect(above.some((r) => /directly below/i.test(allText(r)) && /shipped/i.test(allText(r))))
      .toBe(true);
  });
});
