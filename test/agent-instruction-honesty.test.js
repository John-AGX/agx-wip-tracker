// AN AGENT INSTRUCTION THAT NAMES A CONTEXT BLOCK MUST NAME ONE THAT EXISTS.
//
// ── THE CLASS, NOT THE INSTANCE ───────────────────────────────────────────
// On 2026-09-06 two places in this repo told 86 that its per-turn job context
// names the job's change orders, quoting the format: "CO-3 — income $X, cost
// $Y". Both were false, and had been since ab8d9e51 (17 May). The "# Change
// orders" block sits inside `if (!slimForRouter)` (ai-routes.js:5571-5956);
// slimForRouter DEFAULTS TRUE, and the one call site that passes false also
// passes escalationLean, which returns earlier. The live /86/chat path calls
// buildJobContext with no opts at all.
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
// ── WHAT THIS FILE MISSED THE FIRST TIME, AND WHY ─────────────────────────
// 2026-09-07. The first version of this guard shipped green while THREE false
// sentences stood in the tree, because it only ever looked at two surfaces:
// agent baselines, and a tool's top-level `description`. A proof agent beat it
// deliberately by moving a lie one level down into `input_schema`; the other
// two were already there and had never been looked at:
//
//   ai-routes.js:1054  input_schema.properties.phase_id.description said a
//                      phase id comes "from the # Structure block". That block
//                      is behind the slim gate — never live. INSIDE A SCHEMA,
//                      so the old collector never read the string.
//   ai-routes.js:1937  the ESTIMATE CONTEXT ITSELF said "see the # Pricing
//                      rules above". No such heading is emitted anywhere in
//                      this repo — the two words appeared exactly once, in the
//                      sentence pointing at them. The context is part of the
//                      prompt; the old collector never read it either.
//   the replacement    sentence written on 2026-09-06 to correct the change-
//                      order lie said the job context carries "the job id,
//                      title and number AND NOTHING ELSE". Executed, it also
//                      emits client, community, address, type, status, target
//                      margin, an attachment roll-up with a photo manifest
//                      CARRYING IDS, and the job notes. Same defect, same
//                      block, new sentence — a tidy phrase that was slightly
//                      wrong, which is how this whole class starts.
//
// So the surface set is now everything the model is actually sent: the
// baselines, EVERY string anywhere inside a tool object (schemas included),
// and the LIVE CONTEXT TEXT ITSELF. And the accessor list is no longer
// restated here — it is derived from `internals`, so a tool group added later
// is scanned without anyone remembering to add it.
//
// ── AND THE OUTER NET ─────────────────────────────────────────────────────
// The executing guard can only judge prose on the paths it executes. Prose
// written into a builder it does NOT execute (buildLeadContext,
// buildClientDirectoryContext, deal-memory.js) would be born outside the
// instrument — which is exactly how the poisoner guard was walked around a day
// earlier. So a second, cheaper check censuses EVERY .js file under server/ AND
// js/ for mid-sentence "# Block" references and requires each to name a block
// that is either live-emitted or emitted by real code behind a gate. It cannot
// tell a gated block from a live one — that is the executing guard's job — but
// nothing can be written that names a block which does not exist AT ALL.
//
// Pointing it at js/ is what found three MORE live falsehoods, in the client.
// js/ai-panel.js returned tool results to the model naming a "# QuickBooks cost
// data block of the system prompt" (behind the slim gate, never emitted) and a
// "# Node graph block" (deleted 2026-08-16). Two of them said STOP and sent 86
// to answer from that block instead — so the refusal landed and the substitute
// it named did not exist. Client-side tool executors write prompt text too, and
// no guard in this repo had ever read any of it.
//
// ── WHAT WOULD MAKE THIS FILE LIE ─────────────────────────────────────────
// A fixture too thin to populate a block would report that block unreachable
// when it is merely unpopulated. That is why the fixture below is maximal —
// every optional job header field, a photo WITH A THUMB KEY (the manifest is
// keyed on thumb_key, not on mime type, and an earlier fixture's jpeg fell
// into Docs and hid the whole Photos block), materials, assemblies, buildings,
// phases, change orders, invoices, POs, QB cost lines, notes, workspace sheets
// — and why the failure messages print the emitted set.
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';

const fs = require('fs');
const path = require('path');

const SERVER_DIR = path.join(__dirname, '..', 'server');
const AI_ROUTES = path.join(SERVER_DIR, 'routes', 'ai-routes.js');
const ADMIN_AGENTS = path.join(SERVER_DIR, 'routes', 'admin-agents-routes.js');

// ── the maximal one-job world ─────────────────────────────────────────────
const JOB = 'job-honesty-1';
const ORG = 'org-honesty-1';
const rowsOf = (r) => ({ rows: r, rowCount: r.length });
const N = (n, f) => Array.from({ length: n }, (_, i) => f(i + 1));

// jobs.data is JSONB — pg hands it back as an OBJECT, and buildJobContext
// spreads it (`...jobRes.rows[0].data`). A JSON STRING here would spread into
// numbered character keys and silently produce an empty-looking job, which is
// exactly the shape that would make this file report a false negative.
//
// EVERY optional header field is set. buildJobContext emits each behind its own
// `if (job.x)`, so a fixture that omits one measures a job that does not have
// it and lets an instruction claim the field is never there.
const JOB_DATA = {
  jobNumber: 'J-2041',
  title: 'Lakeview Commons Re-roof',
  client: 'Lakeview HOA',
  community: 'Lakeview Commons',
  propertyAddr: '100 Lake Dr, Orlando FL',
  jobType: 'Reroof',
  market: 'Orlando',
  status: 'In Progress',
  targetMarginPct: 32,
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

// The photo needs a THUMB KEY. The cascade splits on
// `mime_type.startsWith('image/') && a.thumb_key` (ai-routes.js:5457) — an
// image WITHOUT one is filed as a document, and the entire "## Photos" block,
// the one that publishes attachment ids into the prompt, never renders. An
// earlier fixture here had the jpeg and not the key, and consequently measured
// a job context with no photo manifest in it.
const ATTACHMENTS = [{
  id: 'att1', entity_type: 'job', entity_id: JOB, filename: 'scope.pdf',
  mime_type: 'application/pdf', extracted_text: 'scope text', size_bytes: 1024,
  uploaded_by: 'u1', web_key: 'k/a', position: 1, source: 'job',
}, {
  id: 'att2', entity_type: 'job', entity_id: JOB, filename: 'roof-north.jpg',
  mime_type: 'image/jpeg', extracted_text: null, size_bytes: 90210,
  uploaded_by: 'u1', web_key: 'k/b', thumb_key: 'k/b-thumb', position: 2, source: 'job',
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
    // The estimate context's materials and assemblies blocks are the ONLY
    // place a context builder writes a cross-reference to another block, so a
    // fixture that leaves them unpopulated cannot see the class of defect that
    // lived at :1937 for months.
    if (/FROM materials/i.test(s)) {
      return rowsOf([{ total: 812, recent: 44, top_cats: ['Roofing', 'Coatings', 'Fasteners'] }]);
    }
    if (/FROM assemblies/i.test(s)) return rowsOf([{ total: 37, trades: ['Roofing', 'Coatings'] }]);
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
// Three surfaces, not two: the agent system baselines, EVERY string inside a
// published tool (its description AND its input_schema, at any depth), and the
// per-turn context text itself.

// The accessor list is DERIVED, not restated. The previous version of this
// file hard-coded eleven names; a twelfth group would have been scanned by
// nobody, and nothing would have said so. Same failure shape as a test-poison
// guard that only ever walked one directory.
function toolAccessorNames() {
  return Object.keys(I).filter((k) => /Tools$/i.test(k) && typeof I[k] === 'function');
}

function toolGroups() {
  const out = [];
  for (const g of toolAccessorNames()) {
    let t = [];
    try { t = I[g]() || []; } catch (e) { t = []; }
    out.push({ group: g, tools: Array.isArray(t) ? t : [] });
  }
  return out;
}

// Every string reachable inside a tool object, tagged with where it lives, so a
// failure names `set_phase_buildingId ▸ input_schema.properties.phase_id.
// description` rather than just the tool. A JSON Schema is part of the prompt:
// the model reads property descriptions to decide what to pass.
function stringsIn(node, at, out) {
  if (typeof node === 'string') { out.push({ at: at || '(root)', text: node }); return out; }
  if (Array.isArray(node)) { node.forEach((v, i) => stringsIn(v, at + '[' + i + ']', out)); return out; }
  if (node && typeof node === 'object') {
    for (const k of Object.keys(node)) stringsIn(node[k], at ? at + '.' + k : k, out);
  }
  return out;
}

function publishedTools() {
  const out = [];
  for (const { tools } of toolGroups()) {
    for (const x of tools) if (x && x.name) out.push({ name: x.name, text: String(x.description || '') });
  }
  return out;
}

function toolStringSurfaces() {
  const out = [];
  for (const { tools } of toolGroups()) {
    for (const x of tools) {
      if (!x || !x.name) continue;
      for (const s of stringsIn(x, '', [])) out.push({ name: x.name + ' ▸ ' + s.at, text: s.text });
    }
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

// A reference to a context block, as an instruction would write one: a '#'
// followed by a SPACE and a Capitalised heading, quoted mid-sentence.
//
// The space is load-bearing and was learned the hard way. Without it the
// pattern also matches Excel's error sentinels — `#REF!`, `#DIV/0!`, `#ERR`,
// `#ERROR(...)` — which are values in a spreadsheet engine, not references to
// anything, and which the outer net duly reported from three files. Every
// heading this codebase emits is written '# Name' or '## Name', so requiring
// the space makes the reference form and the heading form the same shape. The
// cost is that a lie spelled '#Structure' would be missed; nothing in the repo
// is written that way, and a heading cannot be either.
// The lookbehind is load-bearing too. Job numbers are written as digit
// placeholders — "S#### Service, RV#### Renovation" (js/guide.js:238) — and a
// bare `#{1,3} ` happily matches the last three of those four hashes. A heading
// marker is a run of hashes that nothing precedes; `####` is not one.
const BLOCK_REF = /(?<!#)#{1,3} ([A-Z][A-Za-z]*(?: [a-z][A-Za-z]*| [A-Z][A-Za-z]*){0,3})/g;

// ── A PROMPT'S OWN HEADINGS ARE NOT CONTEXT-BLOCK REFERENCES ──────────────
// The baselines are written in markdown and carry their own sections — "#
// Reading", "# Writing", "# Tone", "# Memory". So does the context text now
// being scanned: "# Job", "## Docs", "# CURRENT MODE: BUILD". Those are
// structure, not claims about what the context contains, and an earlier draft
// of this file flagged all fifteen of the baselines' own.
//
// The discriminator is positional and total: a heading is the FIRST non-space
// character of its line; a reference to a context block is always quoted inside
// a sentence. No name list, so it cannot go stale.
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
      // Instructions write "the # Node graph block" / "# Structure block above
      // is that computation"; the heading is the name, "block" is the
      // sentence's noun for it — and therefore marks where the name ENDS.
      // Stripping only a trailing "block" left "Structure block above is" as a
      // block name and reported two true sentences as lies.
      out.add(m[1].trim().replace(/\s+blocks?\b.*$/i, '').trim());
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
let LIVE_EST_SYSTEM = '';

beforeAll(async () => {
  // EXACTLY the live calls, both of them, from buildTurnContext — the function
  // /86/chat reaches at :15706:
  //   :2821  buildJobContext(entityId, clientContext, aiPhase, organization)
  //   :2817  buildEstimateContext(entityId, false, aiPhase, organization)
  // No opts on either. Passing any would measure a path nothing takes.
  LIVE_JOB_SYSTEM = sysOf(await I.buildJobContext(JOB, null, 'edit', ORGANIZATION));
  LIVE_JOB_HEADINGS = headingsOf(LIVE_JOB_SYSTEM);
  LIVE_EST_SYSTEM = sysOf(await I.buildEstimateContext(EST, false, 'edit', ORGANIZATION));
  LIVE_EST_HEADINGS = headingsOf(LIVE_EST_SYSTEM);
  LIVE_ANY_HEADINGS = [...new Set(LIVE_JOB_HEADINGS.concat(LIVE_EST_HEADINGS))];
}, 60000);

// The context text is part of the prompt, so it is BOTH a surface that may lie
// and a source of blocks that exist. It was only ever the second.
function instructionSurfaces() {
  return baselineInstructions()
    .concat(toolStringSurfaces())
    .concat([
      { name: 'context:job', text: LIVE_JOB_SYSTEM },
      { name: 'context:estimate', text: LIVE_EST_SYSTEM },
    ]);
}

// What the live job path actually emits, with a maximal fixture behind it.
// Attachments/Docs/Photos/Job notes sit OUTSIDE the slimForRouter gate; every
// money block sits inside it.
const LIVE_JOB_HEADINGS_EXPECTED = ['Job', 'Attachments', 'Docs', 'Photos', 'Job notes'];

describe('the live job context, measured rather than described', () => {
  test('buildJobContext on live defaults emits identity, attachments and notes — no money', () => {
    // The measurement the false sentences contradicted. Stated as the whole
    // set, so a block that starts appearing shows up here as a change rather
    // than silently widening what instructions are allowed to claim.
    expect(LIVE_JOB_HEADINGS).toEqual(LIVE_JOB_HEADINGS_EXPECTED);
    expect(LIVE_JOB_SYSTEM).toMatch(/# Job/);
    expect(LIVE_JOB_SYSTEM).not.toMatch(/# Change orders/);
    expect(LIVE_JOB_SYSTEM).not.toMatch(/# WIP/);
    expect(LIVE_JOB_SYSTEM).not.toMatch(/# Structure/);
    expect(LIVE_JOB_SYSTEM).not.toMatch(/# Workspace sheets/);
    expect(LIVE_JOB_SYSTEM).not.toMatch(/# Invoices/);
    expect(LIVE_JOB_SYSTEM).not.toMatch(/# Purchase orders/);
    expect(LIVE_JOB_SYSTEM).not.toMatch(/# QuickBooks/);
  });

  test('the header fields it emits are MORE than id/title/number', () => {
    // The 2026-09-06 replacement sentence said "the job id, title and number
    // and nothing else". This is the measurement that sentence was checked
    // against — and failed. Pinned as the whole label set of the "# Job" block
    // so the next tidy phrase has something to be wrong about.
    const jobBlock = LIVE_JOB_SYSTEM.split(/\n\s*\n/)[0];
    const labels = (jobBlock.match(/^- [^:\n]+:/gm) || [])
      .map((l) => l.replace(/^- /, '').replace(/:$/, ''));
    expect(labels).toEqual([
      'Id (write target)', 'Title', 'Job number', 'Client', 'Community / property',
      'Address', 'Type', 'Status', 'Target margin',
    ]);
    // And the photo manifest publishes attachment IDS into the prompt — the
    // thing "nothing else" most specifically denied.
    expect(LIVE_JOB_SYSTEM).toMatch(/\[att2\] roof-north\.jpg/);
  });

  test('the sentence describing the job context still describes ALL of it', () => {
    // Not a spelling check: for EVERY block the live context emits, the
    // baseline's change-order paragraph must say what that block is. A new
    // block appearing in the context fails here by name, which is the moment
    // the sentence needs rewriting — the moment that was missed twice.
    const DESCRIBED = {
      'Job':         /header fields/i,
      'Attachments': /attachment roll-up/i,
      'Docs':        /documents by filename/i,
      'Photos':      /photos by attachment id/i,
      'Job notes':   /and the job notes/i,
    };
    const sentence = baselineInstructions().find((b) => b.name === 'baseline:job').text
      .split('\n').find((l) => l.indexOf('CHANGE ORDERS:') === 0) || '';
    expect(sentence).not.toBe('');
    for (const h of LIVE_JOB_HEADINGS) {
      expect([h, DESCRIBED[h] ? DESCRIBED[h].test(sentence) : 'NOT DESCRIBED']).toEqual([h, true]);
    }
    // A closed-world claim is the exact shape that failed. "and nothing else"
    // was true of nothing and had to be re-derived by execution to disprove.
    expect(sentence).not.toMatch(/nothing else/i);
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

  test('the ESTIMATE fixture is rich enough too — materials and assemblies rendered', () => {
    // :1937's false cross-reference lived inside the materials block. A fixture
    // that does not populate materials never reads the sentence at all, and
    // this guard would go green over it exactly as the last one did.
    expect(LIVE_EST_HEADINGS).toContain('Materials catalog');
    expect(LIVE_EST_HEADINGS.some((h) => h.indexOf('Assemblies') === 0)).toBe(true);
    expect(LIVE_EST_HEADINGS.some((h) => h.indexOf('Workspace sheets') === 0)).toBe(true);
  });

  test('slimForRouter defaults TRUE, and the one caller that opts out returns earlier', () => {
    const src = fs.readFileSync(AI_ROUTES, 'utf8');
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
  test('every "# Block" named in a baseline, a tool SCHEMA, or the context is reachable', () => {
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

  test('the collector really reaches INTO input_schema, not just the description', () => {
    // The anti-vacuity check that matters most. Every synthetic detector test
    // below would still pass if someone reverted the deep walk to a shallow
    // `x.description` read — the guard would go quiet and look identical. This
    // one fails instead, and names the tool.
    const surfaces = toolStringSurfaces();
    const schemaSurfaces = surfaces.filter((s) => s.name.indexOf('▸ input_schema') > 0);
    expect(schemaSurfaces.length).toBeGreaterThan(200);
    // The exact string the previous guard could not see, at the exact address
    // the proof agent used to walk around it.
    const phaseId = surfaces.find((s) =>
      s.name === 'set_phase_buildingId ▸ input_schema.properties.phase_id.description');
    expect([!!phaseId, phaseId && phaseId.text]).toEqual([true, phaseId && phaseId.text]);
    expect(phaseId.text).toMatch(/read_job_pct_audit|read_building_breakdown/);
    expect(phaseId.text).not.toMatch(/# Structure/);
  });

  test('the live CONTEXT is scanned as a surface, not only as a source of headings', () => {
    // :1937's lie was written by a context builder into the prompt itself. The
    // old guard read the context to learn what blocks exist and never read it
    // to ask whether it told the truth.
    const names = instructionSurfaces().map((s) => s.name);
    expect(names).toContain('context:job');
    expect(names).toContain('context:estimate');
    expect(LIVE_EST_SYSTEM.length).toBeGreaterThan(1000);
    expect(LIVE_EST_SYSTEM).not.toMatch(/Pricing rules/);
  });

  test('the accessor list is DERIVED from internals, and every group is reached', () => {
    // Hard-coding eleven names is how a twelfth would be born outside the
    // instrument. Derived instead — and a group that stops yielding tools when
    // called bare fails here rather than shrinking the scan in silence.
    const names = toolAccessorNames();
    expect(names.length).toBeGreaterThanOrEqual(11);
    for (const n of ['estimateTools', 'jobTools', 'readTools', 'payloadTools']) {
      expect([n, names.includes(n)]).toEqual([n, true]);
    }
    const total = toolGroups().reduce((a, g) => a + g.tools.length, 0);
    expect(total).toBeGreaterThan(100);
    expect(publishedTools().some((t) => t.name === 'read_change_orders')).toBe(true);
    expect(publishedTools().some((t) => t.name === 'set_phase_buildingId')).toBe(true);
  });

  test('the detector is not vacuous — it finds planted lies at every depth', () => {
    // Every filter in the tests above is empty on a correct tree, so a detector
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

    // A LIE PLANTED AT EACH DEPTH THE COLLECTOR NOW WALKS. These are the exact
    // shapes tried against this guard on 2026-09-07; the first three got past
    // its previous version.
    const planted = [
      { name: 'fake_tool', description: 'top level — see the # Node graph block.',
        input_schema: { type: 'object', properties: {
          a: { type: 'string', description: 'id from the # Structure block.' },
          b: { type: 'array', items: { type: 'string', description: 'see the # Node graph block.' } },
        } } },
    ];
    const found = [];
    for (const s of stringsIn(planted[0], '', [])) {
      for (const n of blockRefsIn(s.text)) found.push(s.at + ' → ' + n);
    }
    expect(found).toEqual([
      'description → Node graph',
      'input_schema.properties.a.description → Structure',
      'input_schema.properties.b.items.description → Node graph',
    ]);

    expect(reaches(['Job'], 'Node graph')).toBe(false);         // the planted lie
    expect(reaches(['Job'], 'Job')).toBe(true);                 // the true claim
    expect(reaches(['Change orders (3)'], 'Change orders')).toBe(true);   // count suffix
    expect(reaches(['Structure (buildings + phases)'], 'Structure')).toBe(true);

    // and the surfaces really are being read
    expect(instructionSurfaces().length).toBeGreaterThan(50);
    expect(instructionSurfaces().some((s) => s.name === 'baseline:job')).toBe(true);
  });

  test('the sentences that started this are gone, and say the true thing', () => {
    const admin = fs.readFileSync(ADMIN_AGENTS, 'utf8');
    const ai = fs.readFileSync(AI_ROUTES, 'utf8');

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

    // :1937 pointed at "# Pricing rules". Those two words appeared exactly once
    // in this repo — in the sentence pointing at them. There was no referent to
    // repair, so the rule is stated where the pointer was.
    expect(ai).not.toMatch(/Pricing rules/);
  });
});

// ── THE OUTER NET ─────────────────────────────────────────────────────────
// Everything above judges the paths it executes. This judges the paths it does
// not: buildLeadContext, buildClientDirectoryContext, buildStaffContext,
// deal-memory.js and anything added tomorrow all write prose into prompts, and
// a lie written there would be born outside the executing instrument — the same
// way a colocated suite was born outside a test-poison guard that only walked
// test/. This cannot tell a live block from a gated one. It can tell a real
// block from one that exists nowhere, which is what "# Pricing rules" was.
describe('the outer net — no prompt source names a block that exists nowhere', () => {
  // server/ AND js/. The client half is not decoration: three live falsehoods
  // of exactly this class were sitting in js/ai-panel.js on 2026-09-07, found
  // only because this net was pointed at it. Client-side tool executors return
  // their error and refusal strings to the MODEL as tool results — two of the
  // three told 86 to "STOP" and answer from a "# QuickBooks cost data block of
  // the system prompt" that is behind the slim gate and never emitted, and the
  // third sent it to a "# Node graph block" deleted on 2026-08-16. A guard
  // that only reads server/ cannot see prompt text the browser writes.
  const ROOTS = [SERVER_DIR, path.join(__dirname, '..', 'js')];

  function promptSourceFiles() {
    const out = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.js')) out.push(p);
      }
    };
    for (const r of ROOTS) if (fs.existsSync(r)) walk(r);
    return out;
  }

  test('every mid-sentence "# Block" in server/ names a block real code emits', () => {
    const files = promptSourceFiles();
    expect(files.length).toBeGreaterThan(20);

    // Pass 1 — every heading any code anywhere can emit. A heading literal is a
    // string that BEGINS with '#', which is the same positional discriminator
    // used inside the prompts themselves.
    const codeHeadings = new Set(LIVE_ANY_HEADINGS);
    const src = new Map();
    for (const f of files) {
      const text = fs.readFileSync(f, 'utf8');
      src.set(f, text);
      // A heading literal may open with escaped newlines — the live
      // reference-sheets block is written `'\n\n# Live reference sheets\n\n'`,
      // and a collector anchored hard to the opening quote called that real
      // block nonexistent. Allow the escapes, and cut the name at the first
      // one that follows it.
      const lit = text.match(/['"`](?:\\[nrt]| )*#{1,3} [A-Z][^'"`\n]*/g) || [];
      for (const s of lit) {
        codeHeadings.add(s.replace(/^['"`](?:\\[nrt]| )*#+\s*/, '').split('\\n')[0].trim());
      }
    }
    const emitted = [...codeHeadings];

    // Pass 2 — every mid-sentence reference, with file:line so a failure is
    // actionable without re-deriving anything.
    const orphans = [];
    for (const f of files) {
      const lines = src.get(f).split('\n');
      for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const lead = raw.search(/\S/);
        if (lead === -1) continue;
        // Skip real JS comment lines: a comment can discuss a block that was
        // deleted, and saying so in a comment is how the last correction
        // taught anyone anything.
        const t = raw.slice(lead);
        if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue;
        for (const name of blockRefsIn(raw)) {
          if (!reaches(emitted, name)) {
            orphans.push(path.relative(path.join(__dirname, '..'), f) + ':' + (i + 1) + ' names "# ' + name + '"');
          }
        }
      }
    }
    expect(orphans).toEqual([]);
  });

  test('the outer net is not vacuous — it sees the references that DO exist', () => {
    // Two mid-sentence references survive in ai-routes.js on purpose: both sit
    // INSIDE `if (!slimForRouter)` and are co-emitted with the block they name,
    // so they are true wherever they are read. The net must be finding them and
    // clearing them, not failing to find anything at all.
    const ai = fs.readFileSync(AI_ROUTES, 'utf8');
    const midSentence = ai.split('\n').filter((l) => {
      const lead = l.search(/\S/);
      if (lead === -1) return false;
      const t = l.slice(lead);
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return false;
      return blockRefsIn(l).length > 0;
    });
    expect(midSentence.length).toBeGreaterThanOrEqual(2);
    expect(midSentence.some((l) => /see # Structure/.test(l))).toBe(true);
    expect(midSentence.some((l) => /# WIP block above/.test(l))).toBe(true);
    // ...and both name blocks that this file has PROVEN render, in the
    // "fixture IS rich enough" test above.
    expect(blockRefsIn('either no phase records point at it (see # Structure)')).toEqual(['Structure']);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE SAME CLASS, ONE LEVEL UP: A NAMED CAPABILITY MUST BE A REACHABLE ONE.
 *
 * Everything above asks whether an instruction names a context block that
 * exists. This asks the harder question the same defect kept answering wrong:
 * does an instruction PROMISE 86 something the app can actually do?
 *
 * The instance. 86's baseline said read_project_photos was there "to gather
 * attachment ids before captioning, tagging or building a report from a photo
 * set", the tool's own description repeated it, and add_photo_comment pointed
 * at "emit_payload_file with photo metadata ops". There were no photo metadata
 * ops. PAYLOAD_OPS_SCHEMAS had no attachment key at all, validateOps threw a
 * bare "Unknown entity_type: attachment", and the only statement in the tree
 * that wrote attachments.caption outside the upload INSERT was the HUMAN
 * PUT /api/attachments/:id. Three true-sounding sentences, one missing door,
 * and a user watching the Scribe fail with no error text in the chat.
 *
 * Every test above stayed green through all of it: those sentences name no
 * "# Block", so nothing ever looked at them.
 *
 * The property: every payload OPS KEY and every emit_payload_file ENTITY TYPE
 * an instruction spells out has to exist in the shipped grammar — in
 * PAYLOAD_OPS_SCHEMAS, in the dispatcher map, AND in the enum the model reads
 * to decide a type is legal. Reachable in one of the three and not the others
 * is the deal_memory bug, which shipped once already.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('an instruction may not name a payload capability the grammar lacks', () => {
  const dispatcher = require('../server/services/payload-dispatcher');
  const SCHEMAS = dispatcher.PAYLOAD_OPS_SCHEMAS;

  // The enum on the ONE write tool. Read off the LIVE tool object, not
  // publishedTools() (which keeps only name + description) — the enum is
  // exactly the surface the deal_memory omission hid in.
  function emitTool() {
    for (const { tools } of toolGroups()) {
      const t = tools.find((x) => x && x.name === 'emit_payload_file');
      if (t) return t;
    }
    throw new Error('emit_payload_file is in no published tool group');
  }
  function emitEnum() {
    return emitTool().input_schema.properties.targets.items.properties.entity_type.enum;
  }

  // An ops key as an instruction writes one: "ops.photo_updates",
  // "attachment.ops.photo_updates", "ops: {photo_updates: ...}".
  // Deliberately narrow — a bare word in prose is not a claim about the
  // grammar; a word in one of those positions is.
  // THE BRACE IS LOAD-BEARING on the colon form. emit_payload_file's
  // description writes the INDEX as "entity_type → ops: estimate {op,...}",
  // where the word after "ops:" is an ENTITY TYPE, not an op key — a looser
  // pattern reported that true sentence as a lie. An ops OBJECT literal always
  // opens a brace; the index never does.
  const OPS_KEY_RE = /\bops(?:\.\s*|\s*:\s*\{\s*)['"`]?([a-z][a-z0-9_]{3,})/g;

  function opsKeyRefsIn(text) {
    const out = new Set();
    let m;
    OPS_KEY_RE.lastIndex = 0;
    while ((m = OPS_KEY_RE.exec(String(text)))) out.add(m[1]);
    return [...out];
  }

  // Every top-level op key any entity type actually accepts.
  function reachableOpsKeys() {
    const out = new Set();
    for (const k of Object.keys(SCHEMAS)) {
      for (const top of SCHEMAS[k].allowedTopKeys) out.add(top);
    }
    return out;
  }

  test('every ops.<key> a shipped instruction names is in PAYLOAD_OPS_SCHEMAS', () => {
    const reachable = reachableOpsKeys();
    // Retired ops are named ON PURPOSE, to tell the model to stop emitting
    // them. Naming a thing in order to refuse it is the opposite of the
    // defect, so they are the one exemption — read from the dispatcher's own
    // RETIRED map rather than typed here, so retiring another op later cannot
    // make this guard go quiet about a NEW lie.
    const retired = new Set(Object.keys(dispatcher.internals.RETIRED_JOB_OPS));
    const lies = [];
    for (const surface of instructionSurfaces()) {
      for (const key of opsKeyRefsIn(surface.text)) {
        if (reachable.has(key) || retired.has(key)) continue;
        lies.push(surface.name + ' names ops.' + key + ' — no entity_type accepts it');
      }
    }
    expect({ lies, reachable: [...reachable].sort() })
      .toEqual({ lies: [], reachable: [...reachable].sort() });
  });

  test('the photo-metadata promise is TRUE: attachment.photo_updates exists in all three places', () => {
    expect(Object.keys(SCHEMAS)).toContain('attachment');
    expect([...SCHEMAS.attachment.allowedTopKeys]).toEqual(['photo_updates']);
    expect(emitEnum()).toContain('attachment');
    // Reachable in the DISPATCHER, proven by driving validateTarget on a
    // well-formed target rather than by reading a map.
    expect(() => dispatcher.validateTarget(
      { entity_type: 'attachment', ops: { photo_updates: [{ attachment_id: 'a1', caption: 'x' }] } }, 0
    )).not.toThrow();
    expect(typeof dispatcher.internals.dispatchAttachment).toBe('function');
  });

  test('the three sentences that lied now describe something that exists', () => {
    const baselines = baselineInstructions();
    const job = baselines.find((b) => b.name === 'baseline:job').text;
    const scribe = baselines.find((b) => b.name === 'baseline:scribe').text;
    const tools = publishedTools();
    const photos = tools.find((t) => t.name === 'read_project_photos').text;
    const comment = tools.find((t) => t.name === 'add_photo_comment').text;

    // 86 is told HOW to write them, not merely that it may.
    expect(job).toMatch(/photo_updates/);
    // The Scribe has NO read access and sees only the instruction, so the
    // vocabulary has to be documented there the way every other entity is.
    expect(scribe).toMatch(/attachment_id, caption\?, tags\?/);
    expect(photos).toMatch(/photo_updates/);
    // add_photo_comment pointed at "photo metadata ops" that did not exist.
    expect(comment).not.toMatch(/photo metadata ops/);
    expect(comment).toMatch(/photo_updates/);
  });

  test('every entity_type in the grammar is in the enum, and vice versa', () => {
    // The deal_memory shape of this bug: implemented in the dispatcher for
    // weeks while absent from the enum, so the Scribe could not reach it.
    const enumTypes = emitEnum();
    const schemaTypes = Object.keys(SCHEMAS);
    const missingFromEnum = schemaTypes.filter((t) => !enumTypes.includes(t));
    const missingFromSchemas = enumTypes.filter((t) => !schemaTypes.includes(t));
    expect({ missingFromEnum, missingFromSchemas })
      .toEqual({ missingFromEnum: [], missingFromSchemas: [] });
  });

  test('the detector is not vacuous — a planted promise about a missing op is caught', () => {
    const reachable = reachableOpsKeys();
    const planted = 'Use ops.caption_updates to set a photo description.';
    expect(opsKeyRefsIn(planted)).toEqual(['caption_updates']);
    expect(reachable.has('caption_updates')).toBe(false);
    // And it finds the ones that DO exist, so a green run means it looked.
    expect(opsKeyRefsIn('emit ops.photo_updates for the set')).toEqual(['photo_updates']);
    expect(reachable.has('photo_updates')).toBe(true);
    expect(opsKeyRefsIn('a change_orders op carries ops.line_edits')).toEqual(['line_edits']);
    expect(reachable.has('line_edits')).toBe(true);
  });

  test('the scan actually reaches the surfaces the lies were written on', () => {
    // A guard that scanned nothing would satisfy every assertion above.
    const names = instructionSurfaces().map((s) => s.name);
    expect(names).toContain('baseline:job');
    expect(names).toContain('baseline:scribe');
    expect(names.some((n) => n.indexOf('read_project_photos') === 0)).toBe(true);
    expect(names.some((n) => n.indexOf('emit_payload_file') === 0)).toBe(true);
    const hits = instructionSurfaces().filter((s) => opsKeyRefsIn(s.text).length > 0);
    expect(hits.length).toBeGreaterThan(2);
  });
});
