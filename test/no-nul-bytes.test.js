/* ────────────────────────────────────────────────────────────────────────
 * NO STRAY NUL BYTES IN TRACKED SOURCE.
 *
 * H2, generalized. test/live-writer-permutation.test.js shipped with a raw
 * 0x00 byte at offset 2357, inside `sameColor`, where `''` was clearly meant:
 *
 *     return a === expected.toLowerCase() || a === (RGB[expected] || '<NUL>');
 *
 * Nothing failed. The string never matched, and it was never supposed to —
 * `RGB[expected] || X` only reaches X for a colour not in the table, and every
 * colour asserted on is in the table. So the byte sat there being harmless and
 * doing one thing that was not harmless at all: it made git classify the file
 * as BINARY. `git diff --numstat` reported `- -`, the commit stat read
 * `Bin 0 -> 31264 bytes`, and the evidence file for a defect that had already
 * recurred three times *specifically because reviewers could not see what was
 * covered* became the one file in the commit nobody could read.
 *
 * WHY 8000. git decides binary by looking for a NUL in the first 8000 bytes of
 * a blob, and nowhere else. That is why one file with a NUL at offset 2357 was
 * unreviewable while another with a NUL at offset 206211 diffs perfectly well —
 * a difference of luck, not of kind. The first assertion is therefore the one
 * that matters for review, and it holds even for the allowlisted file: delete
 * enough text above a deliberate NUL and it drifts into the window, and the
 * file silently stops being diffable.
 *
 * The second assertion is the broader hygiene rule, with an explicit
 * allowlist. An entry there is a claim that the byte is deliberate and
 * load-bearing, not that it is tolerated.
 * ──────────────────────────────────────────────────────────────────────── */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const GIT_BINARY_SNIFF_BYTES = 8000;

/* Files whose NUL is intentional. Each entry states WHY, because an allowlist
 * without reasons becomes a place to put things.
 *
 *   server/routes/admin-agents-routes.js
 *     `_sha1(composed + '\0' + (model || ''))` — a NUL domain separator so
 *     that ("ab", "c") and ("a", "bc") cannot hash to the same sync-state key.
 *     A real technique, and the byte IS the semantics: replacing it with any
 *     printable separator would make the collision it prevents possible again.
 *     It sits far past the sniff window, so the file still diffs as text —
 *     which the first assertion below keeps true. */
const ALLOWED = new Set([
  'server/routes/admin-agents-routes.js'
]);

// Extensions a human reads and a reviewer diffs. Binary assets (png, ico,
// xlsx, pdf, woff) are excluded because a NUL there is the format.
const TEXT_EXT = new Set([
  '.js', '.mjs', '.cjs', '.json', '.css', '.html', '.md', '.txt',
  '.sql', '.yml', '.yaml', '.sh', '.svg'
]);

function trackedTextFiles() {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: REPO, maxBuffer: 64 * 1024 * 1024 })
    .toString('utf8');
  return out.split('\0')
    .filter(Boolean)
    .filter((p) => TEXT_EXT.has(path.extname(p).toLowerCase()));
}

function scan() {
  const early = [];     // NUL inside git's binary-sniff window → unreviewable
  const anywhere = [];  // NUL at all
  trackedTextFiles().forEach((rel) => {
    let buf;
    try { buf = fs.readFileSync(path.join(REPO, rel)); } catch (_) { return; }
    const at = buf.indexOf(0);
    if (at < 0) return;
    anywhere.push(rel + ' @' + at);
    if (at < GIT_BINARY_SNIFF_BYTES) early.push(rel + ' @' + at);
  });
  return { early, anywhere };
}

describe('tracked source files stay diffable', () => {
  const found = scan();

  test('no tracked text file carries a NUL inside git\'s binary-sniff window', () => {
    // The assertion that would have caught H2 the day it landed, and the one
    // the allowlist does NOT exempt: a deliberate NUL is fine, a file git
    // refuses to diff is not.
    expect(found.early).toEqual([]);
  });

  test('no tracked text file carries a stray NUL anywhere', () => {
    const stray = found.anywhere.filter((hit) => !ALLOWED.has(hit.split(' @')[0]));
    expect(stray).toEqual([]);
  });

  test('the allowlist has no dead entries', () => {
    // An allowlist that outlives its reason is how the next stray byte gets
    // waved through. If the deliberate NUL is ever removed, this fails and the
    // entry — and its explanation — goes with it.
    const withNul = new Set(found.anywhere.map((hit) => hit.split(' @')[0]));
    ALLOWED.forEach((rel) => expect(withNul.has(rel)).toBe(true));
  });
});
