// test/prompt-graph-vocabulary.test.js — no retired node-graph vocabulary
// may reach an agent prompt.
//
// This is the guard for a defect that has now recurred twice. The node-graph
// engine was retired, but the things that TALK about it were retired one at a
// time, by hand, and each pass missed some:
//
//   pass 1 (8cc8ced) deleted the "# Node graph" block and the wire doctrine
//     from the per-turn job context, and the "N/M unlinked" count under
//     "# Top cost lines".
//   pass 2 (this one) found the SAME unlinked count still being printed ~120
//     lines lower, in the "# QuickBooks cost data" block that calls itself
//     the SINGLE SOURCE OF TRUTH, plus "→ n38" node ids on every sample line,
//     plus two read handlers (read_building_breakdown / read_job_pct_audit)
//     that still returned "allocPct=N%" and "Zero-alloc wires (contribute
//     nothing to rollup)" as tool RESULTS — reachable from the LIVE managed
//     job agent, because read_entity is allowlisted and its own description
//     advertises include:["building_breakdown"] and depth:"audit".
//
// A grep-once-by-hand fix does not survive the next edit. So instead of
// pinning the specific sentences that were removed, this scans every string
// literal that ai-routes.js pushes into a prompt and fails on the vocabulary
// as a class. A prompt string is one passed to lines.push / blocks.push /
// out.push — those three arrays are the prompt/tool-result builders.
//
// If this test fails, do NOT add a carve-out. The rollup is the
// budget-weighted average of the phase records under a building; anything a
// prompt says about wires, allocPct, or node ids moving money is false.

const fs = require('fs');
const path = require('path');

const AI_ROUTES = path.join(__dirname, '..', 'server', 'routes', 'ai-routes.js');
const src = fs.readFileSync(AI_ROUTES, 'utf8');

/**
 * Drop // line comments and block comments.
 *
 * Every removal in this area is documented in a comment that QUOTES the
 * sentence it removed — that is the point of the comment, so a future reader
 * knows what used to ship and why it stopped. Scanning raw source would flag
 * those quotes as violations and push the next person to delete the
 * explanation instead of the defect. Only executable text is evidence.
 */
function stripComments(s) {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/\/\/.*$/gm, '');
}

const code = stripComments(src);

// Vocabulary of the retired engine. Word-bounded so "hardwire", "firewire",
// and "wire one up" (an unrelated admin instruction) don't trip it.
const BANNED = [
  { re: /\ballocPct\b/i,            what: 'allocPct (wire allocation — retired)' },
  { re: /\balloc_pct\b/i,           what: 'alloc_pct (wire allocation — retired)' },
  { re: /\bwires?\b/i,              what: 'wire/wires (the retired rollup edge)' },
  { re: /\bwired\b/i,               what: 'wired (the retired rollup edge)' },
  { re: /graph node/i,              what: 'graph node' },
  { re: /node graph/i,              what: 'node graph' },
  { re: /\bnode_values\b/i,         what: 'node_values (retired op)' },
  { re: /\bwire_updates\b/i,        what: 'wire_updates (retired op)' },
  { re: /\bqb_assignments\b/i,      what: 'qb_assignments (retired op)' },
  { re: /\bt1 pctComplete\b/i,      what: 't1 pctComplete (retired rollup input)' },
];

// The one legitimate mention: the per-turn context and the dispatcher name
// the retired ops in order to REFUSE them. Naming a thing to forbid it is the
// opposite of teaching it, so allow strings that carry an explicit refusal.
const REFUSAL = /retired|refuse|REFUSES|no longer/i;

/**
 * Extract every string literal handed to lines.push(...) / blocks.push(...) /
 * out.push(...). Deliberately simple: it walks the source for the call, then
 * pulls single- and double-quoted literals out of the argument text up to the
 * end of that line. Concatenated multi-line pushes are caught line-by-line,
 * which is what we want — each fragment is judged on its own.
 */
function promptStrings(source) {
  const found = [];
  const lines = source.split('\n');
  let inPush = false;
  let depth = 0;
  lines.forEach((line, i) => {
    const startsPush = /\b(?:lines|blocks|out)\.push\s*\(/.test(line);
    if (startsPush) { inPush = true; depth = 0; }
    if (!inPush) return;
    // Strip line comments so commented-out doctrine (which is how the
    // removals are documented) never trips the scan.
    const code = line.replace(/\/\/.*$/, '');
    // Pull quoted literals.
    const lit = code.match(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g) || [];
    lit.forEach(s => found.push({ line: i + 1, text: s.slice(1, -1) }));
    for (const ch of code) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
    }
    if (depth <= 0 && !/[+,]\s*$/.test(code.trim())) inPush = false;
  });
  return found;
}

describe('retired node-graph vocabulary never reaches a prompt', () => {
  const strings = promptStrings(src);

  it('finds prompt strings to scan (guard against a broken scanner)', () => {
    // If the extractor silently matches nothing, every assertion below passes
    // vacuously and the test is worthless. ai-routes builds hundreds.
    expect(strings.length).toBeGreaterThan(200);
  });

  BANNED.forEach(({ re, what }) => {
    it(`does not teach ${what}`, () => {
      const hits = strings
        .filter(s => re.test(s.text))
        .filter(s => !REFUSAL.test(s.text));
      const detail = hits
        .map(h => `  ai-routes.js:${h.line}\n    ${h.text.slice(0, 160)}`)
        .join('\n');
      expect(hits.length === 0 ? '' : `\n${detail}\n`).toBe('');
    });
  });
});

describe('the QB cost block does not re-introduce the dead measurements', () => {
  it('never prints an "unlinked to a graph node" count', () => {
    expect(code).not.toMatch(/unlinked to a graph node/i);
  });

  it('does not ship linkedNodeId into the prompt', () => {
    // The client stopped sending it (js/ai-panel.js) and the server stopped
    // rendering it. Either half coming back re-creates the defect.
    expect(code).not.toMatch(/s\.linkedNodeId/);
  });

  it('labels the raw import total as NOT job cost', () => {
    // The sibling "# Top cost lines" block was relabelled in 8cc8ced; this
    // block sat 120 lines below still quoting a raw SUM under a heading that
    // calls itself the SINGLE SOURCE OF TRUTH.
    expect(code).toMatch(/Total imported \(raw sum of every line above\)/);
    // The apostrophe is backslash-escaped in the single-quoted JS literal.
    expect(code).toMatch(/NOT this job\\?'s cost/);
  });
});

describe('the client stops sending the dead fields at the source', () => {
  const panel = stripComments(fs.readFileSync(
    path.join(__dirname, '..', 'js', 'ai-panel.js'), 'utf8'));
  const start = panel.indexOf('function buildJobClientContext');
  const ctxBuilder = panel.slice(start, start + 6000);

  it('locates the turn-context builder (guard against a renamed function)', () => {
    expect(start).toBeGreaterThan(-1);
    expect(ctxBuilder).toMatch(/ctx\.qbCosts\s*=/);
  });

  it('does not compute an unlinkedCount for the turn context', () => {
    expect(ctxBuilder).not.toMatch(/unlinkedCount/);
  });

  it('does not put linkedNodeId on a qbCosts sample line', () => {
    expect(ctxBuilder).not.toMatch(/linkedNodeId/);
  });
});
