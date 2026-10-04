'use strict';

// WHY THIS FILE EXISTS
//
// test/agent-instruction-honesty.test.js already guards against telling the
// model about tools it does not hold, and it passes while five such references
// ship. Two structural reasons, not one oversight:
//
//   1. It runs test.each(['job', 'assistant']), so the SCRIBE baseline has
//      never been examined — and three of the five live there. The Scribe holds
//      exactly ONE tool and its baseline names three others.
//   2. Its extractor requires a parenthesis, so a name written in backticks
//      with no call syntax is invisible to it.
//
// This suite closes both. It scans every model-visible string on all three
// agents — baselines, every registered tool description, every property
// description, and the per-turn blocks — and reports any reference the reading
// agent cannot act on.
//
// THE HARD PART WAS NOT FINDING THEM, IT WAS NOT DROWNING IN THEM. The first
// run of this scan reported 45 names, 43 of which were backticked JSON field
// names (`co_id`, `line_id`, `qty_per_unit`, `to_date`) and bare English verbs
// caught by the call-form pattern (`read(`, `list(`). The existing guard has
// the consequence written down at its own line 1060: "a guard that failed on
// those would be noise nobody keeps." A noisy guard gets deleted, and then
// there is no guard. So the filters are pinned by tests of their own below —
// they are load-bearing, not incidental.

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ledger = require('../server/services/agent-capability-ledger');

const AI_ROUTES = path.join(__dirname, '..', 'server', 'routes', 'ai-routes.js');
const LEDGER = path.join(__dirname, '..', 'server', 'services', 'agent-capability-ledger.js');
const AI_SRC = fs.readFileSync(AI_ROUTES, 'utf8');

const internals = require('../server/routes/ai-routes-internals');
const admin = require('../server/routes/admin-agents-routes');

const KEYS = ['job', 'assistant', 'scribe'];

const POOL = ledger.poolNames(internals);
const ALIASES = ledger.dispatchAliases(AI_SRC);
const REACHABLE = {};
for (const k of KEYS) {
  REACHABLE[k] = ledger.reachableNames(ledger.registeredNames(admin.customToolsFor(k)), ALIASES);
}

// The lexicon: every string a model reads, with the agent that reads it.
function buildLexicon() {
  const entries = [];
  for (const k of KEYS) {
    const b = admin.AGENT_SYSTEM_BASELINE && admin.AGENT_SYSTEM_BASELINE[k];
    if (b) entries.push({ id: 'baseline:' + k, agentKey: k, text: String(b) });
    for (const t of admin.customToolsFor(k)) {
      entries.push({ id: 'tool_desc:' + k + ':' + t.name, agentKey: k, text: String(t.description || '') });
      const props = (t.input_schema && t.input_schema.properties) || {};
      for (const p of Object.keys(props)) {
        const d = props[p] && props[p].description;
        if (d) entries.push({ id: 'prop:' + k + ':' + t.name + '.' + p, agentKey: k, text: String(d) });
      }
    }
  }
  // The per-turn blocks are assembled in ai-routes.js, so they are read as
  // source. `job` because that is the only key that reaches a chat turn today.
  const grab = (label, re) => {
    const m = AI_SRC.match(re);
    if (m) entries.push({ id: 'turn_block:' + label, agentKey: 'job', text: m[0] });
    return !!m;
  };
  const located = {
    NUDGE_TEXT: grab('NUDGE_TEXT', /const NUDGE_TEXT[\s\S]{0,2000}?;\r?\n/),
    SURFACE_PRIMARY_WRITES: grab('SURFACE_PRIMARY_WRITES', /const SURFACE_PRIMARY_WRITES[\s\S]{0,1200}?;\r?\n/),
  };
  return { entries, located };
}

const { entries: LEXICON, located: LOCATED } = buildLexicon();

function scan() {
  return ledger.unreachableReferences(LEXICON, {
    pool: POOL,
    reachableFor: (k) => REACHABLE[k] || new Set(),
  });
}

// ── the ratchet ───────────────────────────────────────────────────────────
// Each entry is a reference that EXISTS TODAY and has not been resolved. The
// list may only shrink: a name that stops being a phantom must be REMOVED here
// or the suite fails, so the cleanup cannot be forgotten. Same three properties
// as test/agent-tool-description-cap.test.js:141-195, which is the convention
// this repo already settled on.
//
// EVERY ONE OF THESE IS A REAL DEFECT. They are listed rather than fixed
// because each has two legitimate resolutions and the choice is a product call,
// not a cleanup:
//
//   emit_payload_file / baseline:assistant
//     The Assistant delegates all writes to the Scribe and does not hold this.
//     Either the sentence goes, or the Assistant should hold it.
//
//   read_purchase_history / baseline:job
//     A genuine capability gap: in the pool, registered to no agent, and with
//     NO dispatchReadTool alias either — so there is no path to it at all.
//     Either register it or stop promising it.
//
//   read_change_orders, read_project_photos, view_attachment_image / baseline:scribe
//     THE INSTRUCTIONS GO. Not a toss-up, and the measurement is why: the
//     Scribe's baseline is 22,536 chars — the LARGEST of the three, against
//     job's 20,858 and the Assistant's 12,537 — while it holds exactly ONE
//     tool, emit_payload_file. And driveScribeWrite opens a BRAND-NEW managed
//     session per write (sessions.create at ai-routes.js:15368), so unlike
//     every other agent it pays cache_creation on that whole prefix EVERY
//     WRITE and amortizes nothing. Registering reads here would grow the one
//     prefix in the system that is re-paid per unit of work; it is the single
//     place in this codebase where adding a tool is strictly backwards.
//     The direction of travel is the opposite: execQuickWrite (:15689) already
//     reaches execEmitPayloadFile directly with no model turn and no session,
//     so the destination is more of the write surface moving THERE, not the
//     Scribe acquiring reads.
//     Measure before deleting, though — one prefix-probe run with
//     agentKey='scribe' (admin-agents-routes.js:5472 already accepts it, zero
//     new code). The per-write figure quoted in the planning docs is a
//     chars-ratio estimate, and this program has been wrong three times from
//     exactly that kind of number.
const GRANDFATHERED = new Set([
  'baseline:assistant|emit_payload_file',
  'baseline:job|read_purchase_history',
  'baseline:scribe|read_change_orders',
  'baseline:scribe|read_project_photos',
  'baseline:scribe|view_attachment_image',
]);

describe('the scan is actually looking at something', () => {
  // Vacuity guards. Every assertion below is worthless if the surface came back
  // empty, and an empty surface is exactly what a refactor would produce.
  test('the tool pool, the agents and the aliases are all populated', () => {
    expect(POOL.size).toBeGreaterThan(100);
    expect(ALIASES.size).toBeGreaterThanOrEqual(10);
    expect(REACHABLE.job.size).toBeGreaterThanOrEqual(30);
    expect(REACHABLE.assistant.size).toBeGreaterThanOrEqual(20);
    // The Scribe really does hold one tool. If this ever grows, the three
    // grandfathered scribe entries may be resolvable by registration.
    expect(ledger.registeredNames(admin.customToolsFor('scribe')).size).toBe(1);
  });

  test('the lexicon covers all three agents and the per-turn blocks', () => {
    expect(LEXICON.length).toBeGreaterThan(150);
    for (const k of KEYS) {
      expect(LEXICON.some(e => e.id === 'baseline:' + k)).toBe(true);
      expect(LEXICON.filter(e => e.agentKey === k).length).toBeGreaterThan(1);
    }
    // If a regex stops matching, the block silently leaves the scan — which
    // reads as "no phantoms there" rather than "not looked at".
    expect(LOCATED.NUDGE_TEXT).toBe(true);
    expect(LOCATED.SURFACE_PRIMARY_WRITES).toBe(true);
  });

  test('the scribe baseline is in scope — the gap this suite exists to close', () => {
    const scribe = LEXICON.find(e => e.id === 'baseline:scribe');
    expect(scribe).toBeTruthy();
    expect(scribe.text.length).toBeGreaterThan(5000);
  });
});

describe('no agent is told about a tool it cannot reach', () => {
  test('every unreachable reference is either fixed or explicitly grandfathered', () => {
    const unexpected = scan()
      .map(r => r.id + '|' + r.name)
      .filter(k => !GRANDFATHERED.has(k));
    expect(unexpected).toEqual([]);
  });

  test('the ratchet only turns one way — a fixed name must leave the list', () => {
    const live = new Set(scan().map(r => r.id + '|' + r.name));
    const stale = Array.from(GRANDFATHERED).filter(k => !live.has(k));
    expect(stale).toEqual([]);
  });
});

describe('the filters that keep this guard survivable', () => {
  // These are not incidental: without them the scan reports 45 names, 43 of
  // them noise, and gets deleted.
  const verbs = ledger.toolVerbPrefixes(POOL);

  test('backticked JSON field names are not tool references', () => {
    const refs = ledger.unreachableReferences(
      [{ id: 'x', agentKey: 'job', text: 'Address lines by `line_id`, orders by `co_id`, qty as `qty_per_unit`, and `to_date` / `sort_by` / `attachment_id`.' }],
      { pool: POOL, reachableFor: () => new Set() });
    expect(refs).toEqual([]);
  });

  test('a bare English verb in call form is not a tool reference', () => {
    // `read(`, `list(`, `set(` all match the call-form pattern, and `read` IS a
    // real verb prefix — so the prefix test alone would keep them.
    const refs = ledger.unreachableReferences(
      [{ id: 'x', agentKey: 'job', text: 'You may read(the file), list(them) or set(a value).' }],
      { pool: POOL, reachableFor: () => new Set() });
    expect(refs).toEqual([]);
  });

  test('a fictional tool using a real verb prefix IS reported', () => {
    // The propose_outlook_reply case: a name whose only appearance in the tree
    // was the description telling the model to call it. No schema anywhere, so
    // pool membership cannot catch it — the prefix is what does.
    const refs = ledger.unreachableReferences(
      [{ id: 'x', agentKey: 'job', text: 'To answer, you must use `propose_outlook_reply` with the thread id.' }],
      { pool: POOL, reachableFor: () => new Set() });
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ name: 'propose_outlook_reply', kind: 'no_such_tool' });
  });

  test('a real tool the agent lacks is reported, and named as such', () => {
    const refs = ledger.unreachableReferences(
      [{ id: 'x', agentKey: 'scribe', text: 'First call `read_change_orders` for the CO.' }],
      { pool: POOL, reachableFor: () => new Set() });
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ name: 'read_change_orders', kind: 'registered_to_another_agent' });
  });

  test('a dispatch alias is reachable even though it is registered to nobody', () => {
    // read_wip_summary is in the pool, in NO agent's tool list, and perfectly
    // callable through read_entity. Reporting it would be the noise that gets
    // the guard deleted.
    expect(POOL.has('read_wip_summary')).toBe(true);
    expect(ledger.registeredNames(admin.customToolsFor('job')).has('read_wip_summary')).toBe(false);
    expect(REACHABLE.job.has('read_wip_summary')).toBe(true);
  });

  test('the verb prefixes are derived from the pool, not listed', () => {
    for (const v of ['read', 'propose', 'search']) expect(verbs.has(v)).toBe(true);
    // One-off first segments must NOT become verbs, or the field-name filter
    // stops working.
    for (const v of ['co', 'qty', 'line', 'attachment']) expect(verbs.has(v)).toBe(false);
  });

  test('aliases are read out of the source, so a new dispatch needs no edit here', () => {
    expect(ALIASES.has('read_wip_summary')).toBe(true);
    expect(ledger.dispatchAliases("dispatchReadTool('read_brand_new', x)").has('read_brand_new')).toBe(true);
    expect(ledger.dispatchAliases('nothing here').size).toBe(0);
  });
});

// ── mutants ───────────────────────────────────────────────────────────────
let mutantPaths = [];
afterEach(() => {
  for (const p of mutantPaths) {
    try { delete require.cache[require.resolve(p)]; } catch (e) { /* never loaded */ }
    try { fs.unlinkSync(p); } catch (e) { /* already gone */ }
  }
  mutantPaths = [];
});

function mutantCopy(pairs) {
  let out = fs.readFileSync(LEDGER, 'utf8').replace(/\r\n/g, '\n');
  const src = out;
  for (const [find, replace] of pairs) {
    const n = out.split(find).length - 1;
    if (n !== 1) throw new Error('anchor matched ' + n + ' times: ' + find.slice(0, 60));
    out = out.split(find).join(replace);
  }
  if (out === src) throw new Error('MUTATION CHANGED NO BYTES');
  // Unique per CALL: an index-based name plus a mutantPaths reset in afterEach
  // gives two mutants one path, and jest's module registry is separate from
  // require.cache, so the second require returns the FIRST mutant.
  const file = path.join(os.tmpdir(),
    'mutant-ledger-' + process.pid + '-' + Math.random().toString(36).slice(2, 10) + '.js');
  fs.writeFileSync(file, out);
  mutantPaths.push(file);
  return require(file);
}

describe('mutants', () => {
  const scribeText = [{ id: 'baseline:scribe', agentKey: 'scribe', text: 'Call `read_change_orders` first.' }];

  test('dropping the alias set reports correct instructions as phantoms', () => {
    const broken = mutantCopy([['  for (const a of (aliases || [])) out.add(a);', '  void aliases;']]);
    const reach = broken.reachableNames(ledger.registeredNames(admin.customToolsFor('job')), ALIASES);
    expect(REACHABLE.job.has('read_wip_summary')).toBe(true);
    expect(reach.has('read_wip_summary')).toBe(false);
  });

  test('requiring a paren again hides every backticked reference', () => {
    const broken = mutantCopy([['  for (const re of [BACKTICKED, CALL_FORM]) {', '  for (const re of [CALL_FORM]) {']]);
    expect(ledger.toolShapedTokens('use `read_change_orders` now').has('read_change_orders')).toBe(true);
    expect(broken.toolShapedTokens('use `read_change_orders` now').has('read_change_orders')).toBe(false);
    // and the real finding disappears
    expect(broken.unreachableReferences(scribeText, { pool: POOL, reachableFor: () => new Set() })).toEqual([]);
  });

  test('a prefix threshold of one turns ordinary field names into tools', () => {
    const broken = mutantCopy([[
      'for (const [seg, n] of counts) if (n >= 2) out.add(seg);',
      'for (const [seg, n] of counts) if (n >= 1) out.add(seg);',
    ]]);
    // The probe has to use a segment that appears in the pool EXACTLY ONCE,
    // which is the only thing the threshold decides. `line_id` and `co_id` do
    // not work here — `line` and `co` are not pool segments at any threshold,
    // so my first attempt at this mutant passed under both versions and proved
    // nothing. `start` and `view` each appear once (start_background_task,
    // view_attachment_image), so `start_date` and `view_mode` are admitted at
    // 1 and correctly ignored at 2.
    const text = [{ id: 'x', agentKey: 'job', text: 'Filter with `start_date` and render in `view_mode`.' }];
    expect(ledger.unreachableReferences(text, { pool: POOL, reachableFor: () => new Set() })).toEqual([]);
    expect(broken.unreachableReferences(text, { pool: POOL, reachableFor: () => new Set() }).length)
      .toBeGreaterThan(0);
  });

  test('dropping the underscore requirement brings the bare verbs back', () => {
    const broken = mutantCopy([[
      "      if (!inPool && !(token.indexOf('_') !== -1 && verbs.has(token.split('_')[0]))) continue;",
      "      if (!inPool && !verbs.has(token.split('_')[0])) continue;",
    ]]);
    const text = [{ id: 'x', agentKey: 'job', text: 'You may read(the file) or list(them).' }];
    expect(ledger.unreachableReferences(text, { pool: POOL, reachableFor: () => new Set() })).toEqual([]);
    expect(broken.unreachableReferences(text, { pool: POOL, reachableFor: () => new Set() }).length)
      .toBeGreaterThan(0);
  });
});
