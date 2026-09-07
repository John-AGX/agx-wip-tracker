// AN AGENT INSTRUCTION THAT NAMES A CONTEXT BLOCK MUST NAME ONE THAT EXISTS.
//
// ── THE CLASS, NOT THE INSTANCE ───────────────────────────────────────────
// On 2026-09-06 two places in this repo told 86 that its per-turn job context
// names the job's change orders, quoting the format: "CO-3 — income $X, cost
// $Y". Both were false, and had been since ab8d9e51 (17 May). The "# Change
// orders" block sits inside `if (!slimForRouter)` (ai-routes.js:5571-5956);
// slimForRouter DEFAULTS TRUE, and the one call site that passes false also
// passes escalationLean, which returns earlier. The live /86/chat path calls
// buildJobContext with no opts at all, and it comes back with "# Job", an id, a
// title and a job number.
//
// That defect is invisible to every other test in this repo. Nothing asserts
// that a sentence in a prompt is TRUE. It does not break a build, it does not
// throw, and it does not show up in a diff review — it shows up as 86 confidently
// telling John about change orders it cannot see, or declining to act on ones it
// was told were in front of it.
//
// ── WHY THIS FILE EXECUTES INSTEAD OF READING ─────────────────────────────
// Two verifiers got this question wrong in the SAME DAY, in OPPOSITE
// directions, by reading the code — one of them precisely because the false
// sentences say it in confident English and it believed them. Reading is what
// failed. So the reachable set here is not parsed, inferred or listed: the
// context builders are CALLED, on the same arguments the live path calls them
// with, and whatever headings come out are the headings that exist.
//
// ── WHAT WOULD MAKE THIS FILE LIE ─────────────────────────────────────────
// A fixture too thin to populate a block would report that block unreachable
// when it is merely unpopulated. That is why the fixture below is maximal —
// buildings, phases, change orders, invoices, POs, QB cost lines, attachments,
// notes, workspace sheets — and why the failure message prints the emitted set,
// so the first thing a reader sees is what the builder actually produced.
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';

const path = require('path');

// ── the maximal one-job world ─────────────────────────────────────────────
const JOB = 'job-honesty-1';
const ORG = 'org-honesty-1';
const rowsOf = (r) => ({ rows: r, rowCount: r.length });
const N = (n, f) => Array.from({ length: n }, (_, i) => f(i + 1));

// jobs.data is JSONB — pg hands it back as an OBJECT, and buildJobContext
// spreads it (`...jobRes.rows[0].data`). A JSON STRING here would spread into
// numbered character keys and silently produce an empty-looking job, which is
// exactly the shape that would make this file report a false negative.
const JOB_DATA = {
  jobNumber: 'J-2041',
  title: 'Lakeview Commons Re-roof',
  notes: 'Job notes body, present so the notes block can be emitted.',
  buildings: N(3, (i) => ({ id: 'b' + i, name: 'Building ' + i, pctComplete: 40 + i, budget: 250000 })),
  phases: N(9, (i) => ({
    id: 'p' + i, buildingId: 'b' + ((i % 3) + 1), name: 'Phase ' + i,
    phaseBudget: 80000, asSoldRevenue: 95000, pctComplete: 30 + i,
  })),
  subs: N(3, (i) => ({ id: 's' + i, name: 'Sub ' + i, contractAmount: 120000 })),
};

const CHANGE_ORDERS = N(3, (i) => ({
  id: 'co' + i, job_id: JOB, status: i % 2 ? 'approved' : 'draft', co_number: 'CO-' + i,
  linked_node_id: null, approved_at: '2026-08-0' + i + ' 12:00:00',
  data: {
    coNumber: 'CO-' + i, title: 'Change order ' + i, status: i % 2 ? 'approved' : 'draft',
    lines: N(3, (k) => ({ id: 'l' + i + '_' + k, description: 'line ' + k, qty: 10, unitCost: 100, unitSell: 175 })),
  },
}));

const INVOICES = N(3, (i) => ({
  id: 'inv' + i, status: 'sent', invoice_number: 'INV-' + i,
  issue_date: '2026-07-0' + i, due_date: '2026-08-0' + i, total: 45000, amount_paid: 0,
}));

const POS = N(3, (i) => ({
  id: 'po' + i, status: 'issued', po_number: 'PO-' + i, sub_id: 's' + i, sub_name: 'Sub ' + i,
  data: { poNumber: 'PO-' + i, total: 22000, lines: N(2, (k) => ({ description: 'item ' + k, amount: 5000 })) },
}));

const QB_LINES = N(12, (i) => ({
  job_id: JOB, amount: 1200 + i, linked_node_id: null, report_date: '2026-07-1' + (i % 9),
  account: '50' + (i % 9) + '0 Materials', account_type: 'Cost of Goods Sold',
  bucket: 'material', vendor: 'Vendor ' + (i % 4),
}));

const ATTACHMENTS = [{
  id: 'att1', entity_type: 'job', entity_id: JOB, filename: 'scope.pdf',
  mime_type: 'application/pdf', extracted_text: 'scope text', size_bytes: 1024,
  uploaded_by: 'u1', web_key: 'k/a', position: 1, source: 'job',
}];

const pool = {
  query: async (sql) => {
    const s = String(sql).replace(/\s+/g, ' ').trim();
    if (/FROM jobs j\b/i.test(s)) return rowsOf([{ id: JOB, owner_id: 'u1', data: JOB_DATA }]);
    if (/FROM estimates e\b/i.test(s)) return rowsOf([{ id: EST, owner_id: 'u1', data: EST_DATA }]);
    if (/job_change_orders/i.test(s)) return rowsOf(CHANGE_ORDERS);
    if (/FROM invoices/i.test(s)) return rowsOf(INVOICES);
    if (/job_purchase_orders/i.test(s)) return rowsOf(POS);
    if (/qb_cost_lines/i.test(s)) return rowsOf(QB_LINES);
    if (/FROM attachments/i.test(s)) return rowsOf(ATTACHMENTS);
    return rowsOf([]);
  },
  connect: async () => ({ query: async () => rowsOf([]), release() {} }),
};

jest.mock('../server/db', () => ({ pool: globalThis.__P86_HONESTY_POOL__ }));
globalThis.__P86_HONESTY_POOL__ = pool;

jest.mock('@anthropic-ai/sdk', () => {
  function Fake() { return { messages: {}, beta: { agents: { retrieve: async () => { throw Object.assign(new Error('no network'), { status: 404 }); } } } }; }
  Fake.toFile = async () => ({});
  return Object.assign(Fake, { toFile: Fake.toFile, default: Fake });
});

// admin-agents-routes.js arms a setTimeout AND a setInterval AT MODULE LOAD
// whose handles are, by their own comment, "intentionally not stored". Faking
// the clock across the require and handing it back drops both, so the worker
// can exit. Same reason and same treatment as tenant-noop-differential.
jest.useFakeTimers();
const aiRoutes = require('../server/routes/ai-routes');
const adminAgents = require('../server/routes/admin-agents-routes');
jest.useRealTimers();

const I = aiRoutes.internals;

// ── WHAT THE MODEL IS ACTUALLY SENT ───────────────────────────────────────
// Two surfaces: the agent system baselines, and every published tool's
// `description` (tool schemas are part of the prompt).
const TOOL_ACCESSORS = ['estimateTools', 'jobTools', 'clientTools', 'staffTools',
  'subtaskTools', 'memoryTools', 'projectInlineTools', 'watchTools',
  'payloadTools', 'readTools', 'wave3Tools'];

function publishedTools() {
  const out = [];
  for (const g of TOOL_ACCESSORS) {
    let t = [];
    try { t = I[g]() || []; } catch (e) { t = []; }
    for (const x of t) if (x && x.name) out.push({ name: x.name, text: String(x.description || '') });
  }
  return out;
}

function baselineInstructions() {
  const B = adminAgents.AGENT_SYSTEM_BASELINE;
  if (!B) return [];
  const out = [];
  for (const key of Object.keys(B)) {
    const v = B[key];
    const text = Array.isArray(v) ? v.join('\n') : String(v || '');
    out.push({ name: 'baseline:' + key, text });
  }
  return out;
}

function instructionSurfaces() {
  return baselineInstructions().concat(publishedTools());
}

// A reference to a context block, as an instruction would write one: a '#'
// followed by a Capitalised heading, quoted mid-sentence.
const BLOCK_REF = /#\s?([A-Z][A-Za-z]*(?: [a-z][A-Za-z]*| [A-Z][A-Za-z]*){0,3})/g;

// ── A PROMPT'S OWN HEADINGS ARE NOT CONTEXT-BLOCK REFERENCES ──────────────
// The baselines are written in markdown and carry their own sections — "#
// Reading", "# Writing", "# Tone", "# Memory". Those are the prompt's
// structure, not claims about what the per-turn context contains, and an
// earlier draft of this file flagged all fifteen of them.
//
// The discriminator is positional and total: a prompt heading is the FIRST
// non-space character of its line; a reference to a context block is always
// quoted inside a sentence. No name list, so it cannot go stale.
function blockRefsIn(text) {
  const out = new Set();
  for (const rawLine of String(text).split('\n')) {
    const lead = rawLine.search(/\S/);
    if (lead === -1) continue;
    // Skip the line's own heading marker; scan only what follows it.
    const body = rawLine[lead] === '#' ? rawLine.slice(lead).replace(/^#+[^#]*/, '') : rawLine;
    let m;
    BLOCK_REF.lastIndex = 0;
    while ((m = BLOCK_REF.exec(body))) {
      // Instructions write "the # Node graph block" / "# Structure block"; the
      // heading is the name, "block" is the sentence's noun for it.
      out.add(m[1].trim().replace(/\s+blocks?$/, ''));
    }
  }
  return [...out];
}

// The estimate side has NO slim gate, so its blocks are genuinely live — and an
// instruction is allowed to name a block that exists on the ESTIMATE surface
// even though the job surface has none. "Reachable on a live path" is the
// property, so both live paths are executed and the sets are unioned.
const EST = 'est-honesty-1';
const EST_DATA = {
  title: 'Lakeview Commons — Re-roof',
  totalProposal: 250000,
  status: 'sent',
  scopeOfWork: 'Tear off and replace.',
  // The estimate's "# Workspace sheets" index is emitted only when
  // estimates.data.workbook.sheets is non-empty (ai-routes.js:1873-1882).
  // Without this the fixture would report that block unreachable when it is
  // merely unpopulated — the false-negative this file is built to avoid.
  workbook: { sheets: [
    { name: 'Takeoff', cells: { A1: { v: 1 }, B2: { v: 2 } } },
    { name: 'Summary', cells: { A1: { v: 3 } } },
  ] },
  lines: N(14, (i) => ({
    id: 'l' + i, description: 'line ' + i, qty: 10, unit: 'lf',
    unitCost: 11 + i, markup: 42, group: 'Group ' + ((i % 3) + 1),
  })),
};

const ORGANIZATION = { id: ORG, slug: 'honesty', name: 'Honesty Org' };
// The two builders do NOT return the same shape, and assuming they did is how
// this file first reported the estimate context as 31 characters of
// "[object Object],[object Object]". The JOB side returns `system` as a plain
// string ("Job side stays plain — single string", ai-routes.js:5990); the
// ESTIMATE side returns an ARRAY of cache-control text blocks, because it is
// high enough volume for prompt caching to be worth the structure.
function sysOf(x) {
  const sys = typeof x === 'string' ? x : (x && x.system);
  if (typeof sys === 'string') return sys;
  if (Array.isArray(sys)) {
    return sys.map((b) => (typeof b === 'string' ? b : (b && b.text) || '')).join('\n');
  }
  return sys == null ? '' : String(sys);
}
const headingsOf = (s) => (String(s).match(/^#+ .*$/gm) || []).map((h) => h.replace(/^#+\s*/, '').trim());

// A named block is REACHABLE if some emitted heading starts with it (headings
// carry counts and suffixes: "Change orders (3)", "Structure (buildings + …)").
function reaches(emitted, name) {
  return emitted.some((h) => h === name || h.indexOf(name) === 0 || name.indexOf(h) === 0);
}

let LIVE_JOB_HEADINGS = null;
let LIVE_EST_HEADINGS = null;
let LIVE_ANY_HEADINGS = null;
let LIVE_JOB_SYSTEM = '';

beforeAll(async () => {
  // EXACTLY the live calls, both of them, from buildTurnContext — the function
  // /86/chat reaches at :15706:
  //   :2821  buildJobContext(entityId, clientContext, aiPhase, organization)
  //   :2817  buildEstimateContext(entityId, false, aiPhase, organization)
  // No opts on either. Passing any would measure a path nothing takes.
  LIVE_JOB_SYSTEM = sysOf(await I.buildJobContext(JOB, null, 'edit', ORGANIZATION));
  LIVE_JOB_HEADINGS = headingsOf(LIVE_JOB_SYSTEM);
  LIVE_EST_HEADINGS = headingsOf(sysOf(await I.buildEstimateContext(EST, false, 'edit', ORGANIZATION)));
  LIVE_ANY_HEADINGS = [...new Set(LIVE_JOB_HEADINGS.concat(LIVE_EST_HEADINGS))];
}, 60000);

// What the live job path actually emits, with a maximal fixture behind it.
// Attachments/Docs/Job notes sit OUTSIDE the slimForRouter gate; every money
// block sits inside it.
const LIVE_JOB_HEADINGS_EXPECTED = ['Job', 'Attachments', 'Docs', 'Job notes'];

describe('the live job context, measured rather than described', () => {
  test('buildJobContext on live defaults emits "# Job" and nothing else', () => {
    // The measurement the two false sentences contradicted. Stated as the whole
    // set, so a block that starts appearing shows up here as a change rather
    // than silently widening what instructions are allowed to claim.
    // The WHOLE set, so a block that starts appearing shows up here as a change
    // rather than silently widening what an instruction may claim.
    expect(LIVE_JOB_HEADINGS).toEqual(LIVE_JOB_HEADINGS_EXPECTED);
    expect(LIVE_JOB_HEADINGS).toContain('Job');
    expect(LIVE_JOB_SYSTEM).toMatch(/# Job/);
    expect(LIVE_JOB_SYSTEM).not.toMatch(/# Change orders/);
    expect(LIVE_JOB_SYSTEM).not.toMatch(/# WIP/);
    expect(LIVE_JOB_SYSTEM).not.toMatch(/# Structure/);
    expect(LIVE_JOB_SYSTEM).not.toMatch(/# Workspace sheets/);
  });

  test('the fixture IS rich enough — the same data DOES render when the gate is open', () => {
    // The control that stops this file lying. If the blocks were missing
    // because the fixture is thin rather than because the gate is shut, they
    // would be missing here too.
    return I.buildJobContext(JOB, null, 'edit', ORGANIZATION, { slimForRouter: false }).then((full) => {
      const h = headingsOf(sysOf(full));
      expect(h).toContain('Job');
      expect(h.some((x) => x.indexOf('Change orders') === 0)).toBe(true);
      expect(h.some((x) => x.indexOf('WIP snapshot') === 0)).toBe(true);
      expect(h.some((x) => x.indexOf('Structure') === 0)).toBe(true);
      // ...and that path is reached by NO live caller, which is the point.
    });
  }, 60000);

  test('slimForRouter defaults TRUE, and the one caller that opts out returns earlier', () => {
    const src = require('fs').readFileSync(
      path.join(__dirname, '..', 'server', 'routes', 'ai-routes.js'), 'utf8');
    // The default, at the source of truth.
    expect(src).toMatch(/const slimForRouter = !\(opts && opts\.slimForRouter === false\)/);
    // Every call site that turns the gate off. If a future one appears WITHOUT
    // escalationLean, the full block becomes live and this fails — which is the
    // correct moment to revisit what the instructions are allowed to promise.
    const optOuts = src.match(/buildJobContext\([^)]*slimForRouter:\s*false[^)]*\)/g) || [];
    expect(optOuts.length).toBeGreaterThan(0);
    for (const call of optOuts) expect([call, /escalationLean:\s*true/.test(call)]).toEqual([call, true]);
  });
});

describe('no shipped instruction names a context block that is not there', () => {
  test('every "# Block" named in a baseline or a tool description is reachable', () => {
    // THE CLASS. Per instruction, per block, never a count — the failure names
    // the surface, the block, and what the builder actually emitted, because
    // "some instruction is wrong" is not something anyone can act on.
    const emitted = LIVE_ANY_HEADINGS;
    const lies = [];
    for (const surface of instructionSurfaces()) {
      for (const name of blockRefsIn(surface.text)) {
        if (!reaches(emitted, name)) {
          lies.push(surface.name + ' names "# ' + name + '" — emitted on NO live path');
        }
      }
    }
    expect({ lies, emittedOnAnyLivePath: emitted })
      .toEqual({ lies: [], emittedOnAnyLivePath: emitted });
  });

  test('the detector is not vacuous — it finds a planted lie and clears a true claim', () => {
    // Every filter in the test above is empty on a correct tree, so a detector
    // that had stopped looking would be indistinguishable from a clean result.
    expect(blockRefsIn('ids MUST exist in the # Node graph block')).toEqual(['Node graph']);
    expect(blockRefsIn('no hash here at all')).toEqual([]);
    // The capture runs on past the heading into the sentence ("# WIP snapshot
    // above carries cost"). That over-capture is SAFE and deliberate: reaches()
    // matches on either side's prefix, so a longer reference still resolves to
    // the heading it starts with. Tightening the pattern to stop at exactly the
    // right word would be guessing where a heading ends, and guessing SHORT is
    // the dangerous direction — it invents block names that were never claimed.
    expect(blockRefsIn('the # WIP snapshot above carries cost')[0]).toMatch(/^WIP snapshot/);
    expect(reaches(['WIP snapshot'], 'WIP snapshot above carries')).toBe(true);

    // A prompt's OWN section headings are not references, whatever they are called.
    expect(blockRefsIn('# Reading\n`search_entities(...)` — find ids.')).toEqual([]);
    expect(blockRefsIn('# Tone')).toEqual([]);
    // ...but a reference on the same line as a heading is still seen.
    expect(blockRefsIn('# Reading — see the # Node graph block')).toEqual(['Node graph']);

    expect(reaches(['Job'], 'Node graph')).toBe(false);         // the planted lie
    expect(reaches(['Job'], 'Job')).toBe(true);                 // the true claim
    expect(reaches(['Change orders (3)'], 'Change orders')).toBe(true);   // count suffix
    expect(reaches(['Structure (buildings + phases)'], 'Structure')).toBe(true);

    // and the surfaces really are being read
    expect(instructionSurfaces().length).toBeGreaterThan(50);
    expect(instructionSurfaces().some((s) => s.name === 'baseline:job')).toBe(true);
    expect(instructionSurfaces().some((s) => s.name === 'read_change_orders')).toBe(true);
  });

  test('the two sentences that started this are gone, and say the true thing', () => {
    const fs = require('fs');
    const admin = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'admin-agents-routes.js'), 'utf8');
    const ai = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'ai-routes.js'), 'utf8');

    expect(admin).not.toMatch(/job-context block above names them/);
    // The ai-routes text is a COMMENT, not a prompt — it never reached the
    // model, it misled READERS, twice, in one day. It still quotes the old
    // sentence because a correction that deletes what it corrects teaches
    // nobody; what must be true is that it no longer ASSERTS it.
    expect(ai).toMatch(/THIS COMMENT USED TO SAY/);
    expect(ai).toMatch(/IT DOES NOT, AND HAS NOT SINCE ab8d9e51/);

    // and the replacement points at the tool that actually works. read_change_orders
    // was itself broken from 23 Aug to 4 Sep (it asked for a jobs.job_number
    // column that does not exist) and was fixed in 18ea954b, so it IS the path.
    // Through the same normaliser the surface list uses — a baseline may be a
    // string or an array of lines, and duplicating that assumption here is how
    // the two would drift into disagreeing about what a baseline is.
    const baseline = baselineInstructions().find((b) => b.name === 'baseline:job').text;
    expect(baseline).toMatch(/CHANGE ORDERS: your per-turn job context does NOT list them/);
    expect(baseline).toMatch(/read_change_orders/);
    expect(publishedTools().some((t) => t.name === 'read_change_orders')).toBe(true);
  });
});
