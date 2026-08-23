/* ──────────────────────────────────────────────────────────────────────────
 * test/helpers/cache-buster.js — is a file's ?v tag telling the truth?
 *
 * THE RULE THIS REPO ACTUALLY HAS: editing a js/ or css/ file requires bumping
 * that file's `?v=N` in index.html IN THE SAME COMMIT. Miss it and the browser
 * (and the service worker) keep serving the old body under the old tag; revert
 * it later and the new body is served under a tag clients already cached.
 *
 * WHY THIS IS NOT A NUMBER
 * The obvious guard is `expect(ver('jobs.js')).toBe(230)`. It works exactly
 * once: the next edit to jobs.js turns it red for no reason, which teaches the
 * next person that the response to this test is to retype the number — the one
 * habit that guarantees nobody ever checks whether they bumped. Loosening it to
 * `toBeGreaterThanOrEqual(230)` while the file ships at 231 is worse: it is
 * permanently satisfied, so it catches nothing at all, including the revert it
 * was loosened to keep catching.
 *
 * Neither number is the invariant. The invariant is a RELATIONSHIP between the
 * file and its tag, and git already holds both halves:
 *
 *   bumpedWithLastEdit — the commit that last touched this file also changed
 *                        this file's ?v in index.html. That is "you edited it
 *                        and did not bump it", asked of the actual edit.
 *   notReverted        — the tag today is not BELOW the tag that commit set.
 *                        That is "somebody reverted your bump".
 *   dirtyIsBumped      — if the file differs from HEAD right now (the edit is
 *                        still in the working tree), its tag is already above
 *                        HEAD's. That is the same rule, caught before the
 *                        commit rather than after it.
 *
 * No literal anywhere, and every clause can fail. `historyAvailable` is
 * reported and asserted too: a guard that quietly turns into a no-op because
 * git could not answer is the failure mode this file exists to end.
 * ────────────────────────────────────────────────────────────────────────── */
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const INDEX = 'index.html';

function git(...args) {
  return execFileSync('git', args, { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] });
}

function tagRe(file) {
  const esc = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('(?:src|href)="' + esc + '\\?v=([0-9]+)([a-z]?)"');
}

/* A tag is a number and an optional letter suffix ('6b' is a real one here).
 * null = the file is referenced with no ?v at all, or not referenced. */
function tagIn(html, file) {
  const m = String(html).match(tagRe(file));
  return m ? { n: Number(m[1]), s: m[2] || '', raw: m[1] + (m[2] || '') } : null;
}
const same = (a, b) => (a === null || b === null) ? a === b : (a.n === b.n && a.s === b.s);
const below = (a, b) => (a === null || b === null) ? false : (a.n < b.n || (a.n === b.n && a.s < b.s));

function tagAt(rev, file) {
  try { return tagIn(git('show', rev + ':' + INDEX), file); } catch (e) { return undefined; } // undefined = git could not answer
}

/* What this file's tag is doing, as one flat object — so a failing expect()
 * prints the file, the tag and which clause broke, instead of "false". */
function report(file) {
  const out = {
    file,
    tagged: false,
    historyAvailable: false,
    bumpedWithLastEdit: false,
    notReverted: false,
    dirtyIsBumped: false,
  };

  const workingTag = tagIn(fs.readFileSync(path.join(REPO, INDEX), 'utf8'), file);
  out.tagged = workingTag !== null;
  out.tag = workingTag ? workingTag.raw : null;
  if (!out.tagged) return out;

  let last = '';
  try { last = git('log', '-n', '1', '--format=%H', '--', file).trim(); } catch (e) { last = ''; }
  const atLast = last ? tagAt(last, file) : undefined;
  const atParent = last ? tagAt(last + '^', file) : undefined;
  const headTag = tagAt('HEAD', file);
  // Every question below needs git to have answered. atParent may legitimately
  // be null (the file's first commit — the tag APPEARED, which is a bump), but
  // it may not be undefined (unreachable history: a shallow clone, no .git).
  out.historyAvailable = !!last && atLast !== undefined && atParent !== undefined && headTag !== undefined;
  if (!out.historyAvailable) return out;

  out.lastEdit = last.slice(0, 8);
  out.bumpedWithLastEdit = !same(atLast, atParent);
  out.notReverted = !below(workingTag, atLast);

  let dirty = '';
  try { dirty = git('status', '--porcelain', '--', file).trim(); } catch (e) { dirty = ''; }
  // A string, not a boolean, on purpose: the clause list is asserted by name
  // (co-completion-port E3b), and a diagnostic that reads as a clause would
  // make that assertion go red for a file that is merely mid-edit.
  out.worktree = dirty === '' ? 'clean' : 'modified';
  out.dirtyIsBumped = dirty === '' ? true : below(headTag, workingTag);
  return out;
}

/* The shape a healthy file reports. Spread it into an expected object so the
 * assertion reads as "this file, bumped with its last edit, not reverted". */
function healthy(file) {
  return { file, tagged: true, historyAvailable: true, bumpedWithLastEdit: true, notReverted: true, dirtyIsBumped: true };
}

/* Every js/css file index.html tags, for callers that want the whole set. */
function taggedFiles(html) {
  const src = html || fs.readFileSync(path.join(REPO, INDEX), 'utf8');
  return [...src.matchAll(/(?:src|href)="((?:js|css)\/[^"?]+)\?v=[0-9]+[a-z]?"/g)].map((m) => m[1]);
}

module.exports = { report, healthy, taggedFiles, tagIn };
