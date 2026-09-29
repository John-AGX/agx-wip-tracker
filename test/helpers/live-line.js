/* ──────────────────────────────────────────────────────────────────────────
 * test/helpers/live-line.js — a statement that is actually RUNNING.
 *
 * A source-reading test written as `expect(src).toContain('delete x.y;')`
 * passes just as happily on `// delete x.y;`. That was found by mutation:
 * commenting the line out left the suite green, so the test proved nothing
 * about the guard it was named for. Same shape as the other silent passes in
 * this repo — a needle that a dead line satisfies.
 *
 *   expect(liveLine(src, 'delete jobBlob.bt_created_at;')).toBe(true);
 *
 * Line-based and deliberately simple: it asks whether SOME line, once its
 * indentation is removed, begins with the text — so a leading // or * (a
 * block-comment continuation) fails it. It does not parse, so it cannot tell
 * a line buried inside a multi-line block comment from a live one; keep the
 * needle distinctive enough that there is only one of it.
 * ────────────────────────────────────────────────────────────────────────── */
'use strict';

function liveLine(src, text) {
  const lines = String(src).replace(/\r\n/g, '\n').split('\n');
  return lines.some((l) => l.trim().startsWith(text));
}

// Every line that CONTAINS the text and is not commented out, for a needle
// that appears mid-line (an argument, a property inside an object literal).
function liveLines(src, text) {
  return String(src).replace(/\r\n/g, '\n').split('\n')
    .filter((l) => l.includes(text))
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    });
}

module.exports = { liveLine, liveLines };
