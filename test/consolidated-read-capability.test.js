// THE CONSOLIDATED READ DOOR ANSWERS TO THE SAME CAPABILITY AS THE READER
// BEHIND IT.
//
// ── WHAT WAS WRONG ────────────────────────────────────────────────────────
// read_entity / search_entities are a front door. execConsolidatedRead turns
// an entity_type into a call on a narrow reader (read_users, read_jobs,
// read_wip_summary, ...), and consolidatedReadCapability is supposed to charge
// the caller the capability THAT reader charges. It had no `user` case and ends
// in `default: return null`, so:
//
//   read_users                               -> refused a LEADS_VIEW-only user
//   search_entities{entity_type:'user'}      -> served that user the roster
//
// through the same handler, on both 86 and the Assistant. A second disagreement
// sat in the `job` arm: filters:[''] was PRICED as a filtered roster search
// (JOBS_VIEW_ALL) and SERVED as the unfiltered WIP roll-up (FINANCIALS_VIEW).
//
// ── HOW THIS FILE PROVES IT ───────────────────────────────────────────────
// 1. Every entity_type either door routes, with the capability it requires.
//    For each one: a user holding EVERY capability except the required ones is
//    refused, and the same user plus exactly one required capability is
//    allowed. Only the capability varies.
// 2. The live agent dispatcher (make86OnCustomToolUse) is DRIVEN, not just the
//    gate function — it is the door the model actually knocks on.
// 3. Parity with the narrow reader, by executing both requirement functions.
// 4. The executor's own "Supported:" list is executed and parsed, so a type
//    added to the door without a gate fails here the day it lands.
// 5. The refusal is not an existence oracle.
// 6. Each new guard is REMOVED from a copy of the shipped source and the same
//    drive is shown to leak (see the CRLF note on mutate()).
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema } = require('./helpers/db-schema');

const REPO = path.join(__dirname, '..');
const REAL = path.join(REPO, 'server', 'routes', 'ai-routes.js');
const REAL_DIR = path.dirname(REAL);
const SOURCE = fs.readFileSync(REAL, 'utf8');
const BUILTINS = new Set(require('module').builtinModules);
const abs = (p) => p.split(path.sep).join('/');

function absolutizeRequires(src) {
  return src.replace(/require\((['"])([^'"]+)\1\)/g, (m, q, spec) => {
    if (spec.startsWith('.')) return `require(${q}${abs(path.resolve(REAL_DIR, spec))}${q})`;
    if (BUILTINS.has(spec) || spec.startsWith('node:')) return m;
    return `require(${q}${abs(path.join(REPO, 'node_modules', spec))}${q})`;
  });
}

// Load a copy of ai-routes.js with `pairs` applied and the live dispatcher
// factory exported. The copy lives in the OS temp dir: suites that census
// server/ and test/ would otherwise pick up a transient file.
//
// THE CRLF TRAP: the repo is core.autocrlf=true, and an LF anchor against CRLF
// bytes matches nothing. Anchors are normalised to the file's real line ending,
// an absent anchor throws, and a replace that moved no bytes throws.
const loadedPaths = [];
function load(pairs) {
  const eol = SOURCE.indexOf('\r\n') !== -1 ? '\r\n' : '\n';
  let out = SOURCE;
  for (const [find, replace] of pairs) {
    const f = String(find).replace(/\r?\n/g, eol);
    const r = String(replace).replace(/\r?\n/g, eol);
    const at = out.indexOf(f);
    if (at === -1) throw new Error('MUTATION ANCHOR NOT FOUND: ' + JSON.stringify(f.slice(0, 200)));
    if (out.indexOf(f, at + 1) !== -1) throw new Error('MUTATION ANCHOR NOT UNIQUE: ' + JSON.stringify(f.slice(0, 200)));
    const next = out.slice(0, at) + r + out.slice(at + f.length);
    if (next === out) throw new Error('MUTATION CHANGED NO BYTES: ' + f.slice(0, 80));
    out = next;
  }
  out += eol + 'module.exports.__make86OnCustomToolUse = make86OnCustomToolUse;' + eol;
  const p = path.join(os.tmpdir(), '_p86_consolread_' + process.pid + '_' +
    Math.random().toString(36).slice(2, 10) + '.js');
  fs.writeFileSync(p, absolutizeRequires(out), 'utf8');
  loadedPaths.push(p);
  jest.useFakeTimers();
  let m;
  try { m = require(p); } finally { jest.useRealTimers(); }
  return m;
}

// ── the world ─────────────────────────────────────────────────────────────
const TABLES = ['users', 'organizations', 'roles', 'leads', 'clients', 'jobs', 'tasks',
  'context_load_events', 'job_change_orders', 'invoices', 'qb_cost_lines',
  'job_vendor_bills', 'job_purchase_orders'];

let eng, auth, ALL_CAPS, shipped;

// ── THE ENUMERATION ───────────────────────────────────────────────────────
// Every entity_type search_entities and read_entity route, every shape that
// changes which narrow reader answers, and the capability each one requires.
// `null` rows are the ungated ones; each carries its justification.
const JVA = 'JOBS_VIEW_ALL';
const FIN = 'FINANCIALS_VIEW';
const EV = 'ESTIMATES_VIEW';
const LV = 'LEADS_VIEW';
const S = 'search_entities';
const R = 'read_entity';

const ROWS = [
  // search_entities
  [S, { entity_type: 'job' },                      [FIN],     'read_wip_summary'],
  [S, { entity_type: 'job', filter: '25' },        [JVA],     'read_jobs'],
  [S, { entity_type: 'job', q: '25' },             [JVA],     'read_jobs'],
  [S, { entity_type: 'job', filters: ['25'] },     [JVA],     'read_jobs'],
  [S, { entity_type: 'job', filters: [''] },       [JVA],     'executor refuses unless the caller also holds FINANCIALS_VIEW'],
  [S, { entity_type: 'wip' },                      [FIN],     'read_wip_summary'],
  [S, { entity_type: 'client', filter: 'a' },      [EV, LV],  'read_clients'],
  [S, { entity_type: 'lead', filter: 'a' },        [LV],      'read_leads'],
  [S, { entity_type: 'user', filter: 'a' },        [JVA, EV], 'read_users'],
  [S, { entity_type: 'USER', filter: 'a' },        [JVA, EV], 'read_users (case-folded)'],
  [S, { entity_type: ['user'], filter: 'a' },      [JVA, EV], 'read_users (String([\'user\']) === \'user\')'],
  [S, { entity_type: 'user', filters: ['a', 'b'] }, [JVA, EV], 'read_users (batched)'],
  [S, { entity_type: 'estimate', filter: 'a' },    [EV],      'read_past_estimates'],
  [S, { entity_type: 'material', filter: 'a' },    [EV],      'read_materials'],
  [S, { entity_type: 'sub', filter: 'a' },         [EV],      'read_subs'],
  [S, { entity_type: 'business_card', filter: 'a' }, [EV, LV], 'read_existing_clients'],
  [S, { entity_type: 'pipeline' },                 [LV],      'unsupported by search (stricter than needed)'],
  [S, { entity_type: 'purchase_order' },           [JVA],     'fold: read_purchase_orders'],
  [S, { entity_type: 'change_order' },             [JVA],     'fold: read_change_orders'],
  [S, { entity_type: 'project' },                  [JVA],     'fold: read_projects'],
  [S, { entity_type: 'assembly' },                 [EV],      'fold: read_assemblies'],
  [S, { entity_type: 'task', filter: 'a' },        null,      'read_tasks: no entry; org + personal-owner predicate in the reader; GET /api/tasks is requireAuth'],
  [S, { entity_type: 'receipt' },                  null,      'read_receipts: no entry; GET /api/receipts is requireAuth'],
  [S, { entity_type: 'nonsense' },                 null,      'executor answers unsupported, reads nothing'],
  // read_entity
  [R, { entity_type: 'job', id: 'j1' },                                  [JVA],     'read_jobs'],
  [R, { entity_type: 'job', id: 'j1', include: ['qb_cost_lines'] },      [FIN],     'read_qb_cost_lines'],
  [R, { entity_type: 'job', id: 'j1', include: ['building_breakdown'] }, [FIN],     'read_building_breakdown'],
  [R, { entity_type: 'job', id: 'j1', include: ['buildings'] },          [FIN],     'read_building_breakdown'],
  [R, { entity_type: 'job', id: 'j1', depth: 'audit' },                  [FIN],     'read_job_pct_audit'],
  [R, { entity_type: 'job', id: 'j1', include: ['audit'] },              [FIN],     'read_job_pct_audit'],
  [R, { entity_type: 'job', id: 'j1', depth: 'full' },                   [EV, JVA], 'read_workspace_sheet_full'],
  [R, { entity_type: 'job', id: 'j1', include: ['workspace_sheet'] },    [EV, JVA], 'read_workspace_sheet_full'],
  [R, { entity_type: 'job', id: 'j1', include: ['tasks'] },              [JVA],     'read_tasks (stricter)'],
  [R, { entity_type: 'estimate', id: 'e1' },                             [EV],      'read_past_estimates'],
  [R, { entity_type: 'estimate', id: 'e1', depth: 'full' },              [EV],      'read_active_lines'],
  [R, { entity_type: 'estimate', id: 'e1', depth: 'audit' },             [EV],      'read_past_estimate_lines'],
  [R, { entity_type: 'estimate', id: 'e1', include: ['tasks'] },         [EV],      'read_tasks (stricter)'],
  [R, { entity_type: 'client', id: 'c1' },                               [EV, LV],  'inline clients read'],
  [R, { entity_type: 'client', id: 'c1', include: ['tasks'] },           [EV, LV],  'read_tasks (stricter)'],
  [R, { entity_type: 'lead', id: 'l1' },                                 [LV],      'inline leads read'],
  [R, { entity_type: 'lead', id: 'l1', include: ['tasks'] },             [LV],      'read_tasks (stricter)'],
  [R, { entity_type: 'sub', id: 's1', include: ['tasks'] },              [EV],      'read_tasks (stricter)'],
  [R, { entity_type: 'project', id: 'p1', include: ['tasks'] },          [JVA],     'read_tasks: WAS ungated, now JOBS_VIEW_ALL like job+tasks'],
  [R, { entity_type: 'project', id: 'p1' },                              [JVA],     'fold: read_projects'],
  [R, { entity_type: 'pipeline' },                                       [LV],      'read_lead_pipeline'],
  [R, { entity_type: 'wip' },                                            [FIN],     'read_wip_summary'],
  [R, { entity_type: 'user', id: '11' },                                 [JVA, EV], 'unsupported by read_entity (gated anyway)'],
  [R, { entity_type: 'purchase_order', id: 'po1' },                      [JVA],     'fold: read_purchase_orders'],
  [R, { entity_type: 'change_order', id: 'CO-3' },                       [JVA],     'fold: read_change_orders'],
  [R, { entity_type: 'assembly', id: 'a1' },                             [EV],      'fold: read_assemblies'],
  [R, { entity_type: 'task', id: 't1' },                                 null,      'read_tasks: see search row'],
  [R, { entity_type: 'receipt' },                                        null,      'read_receipts: see search row'],
];

// A role name per capability SET, so "vary only the capability" is literal:
// the refused user holds every capability in the system except the required
// ones, and each allowed user is that same set plus exactly one of them.
const roleNames = new Map();
function roleFor(caps) {
  const key = caps.slice().sort().join('|');
  if (!roleNames.has(key)) roleNames.set(key, { name: 'r' + roleNames.size, caps: caps.slice() });
  return roleNames.get(key).name;
}
const without = (need) => ALL_CAPS.filter((c) => need.indexOf(c) === -1);

function seed() {
  const roles = [...roleNames.values()]
    .map((r) => `('${r.name}','${JSON.stringify(r.caps)}')`).join(',');
  eng.db.exec(`
    DELETE FROM users; DELETE FROM organizations; DELETE FROM roles; DELETE FROM leads;
    DELETE FROM clients; DELETE FROM jobs; DELETE FROM tasks;
    INSERT INTO roles (name, capabilities) VALUES ${roles};
    INSERT INTO organizations (id, name) VALUES (1,'AGX');
    INSERT INTO users (id, name, email, role, organization_id, active) VALUES
      (11,'Vera Leadsonly','vera@agx.test','${roleFor([LV])}',1,1),
      (12,'Jake Jobsonly','jake@agx.test','${roleFor([JVA])}',1,1);
    INSERT INTO leads (id, title, organization_id) VALUES ('l1','Waterside Gazebo',1);
    INSERT INTO jobs (id, data, organization_id) VALUES ('j1','{"jobNumber":"25-100","title":"Maple St"}',1);
  `);
}

beforeAll(async () => {
  eng = createPgSqlite(sqliteSchema(TABLES), { jsonColumns: ['capabilities', 'data', 'item_meta'] });
  const db = require('../server/db');
  db.pool.query = eng.pool.query;
  db.pool.connect = eng.pool.connect;
  jest.useFakeTimers();
  auth = require('../server/auth');
  jest.useRealTimers();
  ALL_CAPS = auth.CAPABILITY_KEYS.map((k) => k.key);
  // Register every role any drive below needs before the first seed.
  roleFor([LV]); roleFor([JVA]); roleFor(ALL_CAPS); roleFor([JVA, FIN]); roleFor([FIN]);
  for (const [, , need] of ROWS) {
    if (!need) continue;
    roleFor(without(need));
    for (const cap of need) roleFor(without(need).concat(cap));
  }
  auth.setRolePool(eng.pool);
  shipped = load([]);
  seed();
  await auth.refreshRoleCache();
});

const flush = () => new Promise((r) => setTimeout(r, 25));
afterAll(async () => {
  await flush();
  require('../server/db').pool.query = async () => ({ rows: [], rowCount: 0 });
  if (eng) eng.close();
  for (const p of loadedPaths) { try { fs.unlinkSync(p); } catch (_) {} }
});

const userWith = (caps, id) => ({ id: id || 50, role: roleFor(caps), organization_id: 1 });
const sortNeed = (n) => (n == null ? null : (Array.isArray(n) ? n : [n]).slice().sort());

// The live dispatcher the model's tool calls land on.
function liveDoor(mod, user) {
  return mod.__make86OnCustomToolUse(user.id, null, '', user, 1);
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 1. EVERY ENTITY TYPE: WITHOUT refused, WITH allowed, ONLY THE CAPABILITY VARIES
 * ══════════════════════════════════════════════════════════════════════════*/
describe('every entity_type the consolidated doors route', () => {
  test.each(ROWS.map((r) => [r[0] + ' ' + JSON.stringify(r[1]) + ' -> ' + (r[2] ? r[2].join(' or ') : 'UNGATED') + ' (' + r[3] + ')', r]))(
    '%s',
    (_label, [tool, input, need]) => {
      const I = shipped.internals;
      expect(sortNeed(I.aiToolRequiredCapability(tool, input))).toEqual(sortNeed(need));
      if (!need) {
        // Ungated is a claim too: a user with NO capability at all passes.
        expect(I.aiToolCapabilityDenial(tool, input, userWith([]))).toBeNull();
        return;
      }
      const refused = I.aiToolCapabilityDenial(tool, input, userWith(without(need)));
      expect(refused).toBe(
        'Permission denied: the current user lacks the ' + need.join(' or ') +
        ' capability required to read this. Tell the user you can\'t show this data because ' +
        'their role doesn\'t have access, and suggest they contact an admin if they need it.');
      for (const cap of need) {
        expect(I.aiToolCapabilityDenial(tool, input, userWith(without(need).concat(cap)))).toBeNull();
      }
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 2. THE REPORTED BYPASS, DRIVEN THROUGH THE LIVE DISPATCHER
 * ══════════════════════════════════════════════════════════════════════════*/
describe('search_entities{user} at the live dispatcher', () => {
  const DENY_USERS = 'Permission denied: the current user lacks the JOBS_VIEW_ALL or ESTIMATES_VIEW ' +
    'capability required to read this. Tell the user you can\'t show this data because their role ' +
    'doesn\'t have access, and suggest they contact an admin if they need it.';

  test('a LEADS_VIEW-only user is refused by BOTH doors with the same sentence', async () => {
    const door = liveDoor(shipped, { id: 11, role: roleFor([LV]), organization_id: 1 });
    const narrow = await door({ name: 'read_users', input: { q: 'a' } });
    const wide = await door({ name: 'search_entities', input: { entity_type: 'user', filter: 'a' } });
    expect(narrow).toEqual({ tier: 'auto', error: DENY_USERS });
    expect(wide).toEqual({ tier: 'auto', error: DENY_USERS });
    expect(JSON.stringify(wide)).not.toContain('jake@agx.test');
  });

  test('a JOBS_VIEW_ALL user still reads the roster through search_entities', async () => {
    const door = liveDoor(shipped, { id: 12, role: roleFor([JVA]), organization_id: 1 });
    const r = await door({ name: 'search_entities', input: { entity_type: 'user', filter: 'a' } });
    expect(r.error).toBeUndefined();
    expect(r.summary).toContain('Vera Leadsonly (vera@agx.test)');
  });
});

describe('search_entities{job, filters:[blank]} at the live dispatcher', () => {
  test('a JOBS_VIEW_ALL user without FINANCIALS_VIEW gets no WIP roll-up', async () => {
    const door = liveDoor(shipped, { id: 12, role: roleFor([JVA]), organization_id: 1 });
    for (const filters of [[''], ['   '], ['', ' ']]) {
      const r = await door({ name: 'search_entities', input: { entity_type: 'job', filters } });
      expect(String(r.summary)).toMatch(/^search_entities\(job\): every value in filters was blank/);
      expect(String(r.summary)).not.toContain('WIP ROLL-UP');
    }
  });

  test('blank filters still serve the roll-up to a caller who holds FINANCIALS_VIEW', async () => {
    // The roll-up is what the unfiltered call returns to this same caller, so
    // refusing it here would take away data the role is entitled to.
    for (const caps of [ALL_CAPS, [JVA, FIN], [FIN]]) {
      const door = liveDoor(shipped, { id: 12, role: roleFor(caps), organization_id: 1 });
      for (const filters of [[''], ['   ']]) {
        const r = await door({ name: 'search_entities', input: { entity_type: 'job', filters } });
        // [FIN] alone is refused by the GATE (priced JOBS_VIEW_ALL), never served.
        if (caps.indexOf(JVA) === -1) { expect(r.error).toMatch(/lacks the JOBS_VIEW_ALL capability/); continue; }
        expect(String(r.summary)).toContain('WIP ROLL-UP');
        expect(String(r.summary)).not.toMatch(/every value in filters was blank/);
      }
    }
  });

  test('the unfiltered roll-up still serves a FINANCIALS_VIEW holder', async () => {
    const door = liveDoor(shipped, { id: 12, role: roleFor(ALL_CAPS), organization_id: 1 });
    const r = await door({ name: 'search_entities', input: { entity_type: 'job' } });
    expect(String(r.summary)).toContain('WIP ROLL-UP');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 3. PARITY WITH THE NARROW READER EACH TYPE STANDS IN FOR
 * ══════════════════════════════════════════════════════════════════════════*/
describe('each type charges exactly what its narrow reader charges', () => {
  const PARITY = [
    ['user', 'read_users'],
    ['purchase_order', 'read_purchase_orders'],
    ['change_order', 'read_change_orders'],
    ['project', 'read_projects'],
    ['assembly', 'read_assemblies'],
    ['assembly', 'read_assembly_taxonomy'],
    ['receipt', 'read_receipts'],
    ['task', 'read_tasks'],
    ['lead', 'read_leads'],
    ['client', 'read_clients'],
    ['material', 'read_materials'],
    ['sub', 'read_subs'],
    ['business_card', 'read_existing_clients'],
    ['wip', 'read_wip_summary'],
  ];
  test.each(PARITY)('search_entities{%s} === %s', (et, narrow) => {
    const I = shipped.internals;
    expect(sortNeed(I.aiToolRequiredCapability('search_entities', { entity_type: et, filter: 'x' })))
      .toEqual(sortNeed(I.aiToolRequiredCapability(narrow, {})));
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 4. THE EXECUTOR'S OWN SUPPORTED LIST HAS NO UNGATED MEMBER BUT TASK
 * ══════════════════════════════════════════════════════════════════════════*/
describe('nothing the executor supports falls to default: return null', () => {
  const JUSTIFIED_UNGATED = new Set(['task']);
  const CTX = { userId: 12, orgId: 1, user: { id: 12, role: 'r0', organization_id: 1 } };

  test.each([S, R])('%s', async (tool) => {
    const I = shipped.internals;
    const refusal = String(await I.execAgentTool(tool, { entity_type: 'zz_not_a_type', id: 'x' }, CTX));
    const m = refusal.match(/Supported: ([a-z_, ]+)\.$/);
    expect(m).not.toBeNull();
    const supported = m[1].split(',').map((s) => s.trim()).filter(Boolean);
    expect(supported.length).toBeGreaterThan(5);
    for (const et of supported) {
      const need = I.aiToolRequiredCapability(tool, { entity_type: et, id: 'x' });
      // Named by entity_type so a failure says WHICH type fell through.
      expect({ entity_type: et, gated: need !== null })
        .toEqual({ entity_type: et, gated: !JUSTIFIED_UNGATED.has(et) });
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 5. THE REFUSAL IS NOT AN EXISTENCE ORACLE
 * ══════════════════════════════════════════════════════════════════════════*/
describe('a refusal says the same thing whether or not the row exists', () => {
  test('read_entity{lead} for a real id and an invented one', async () => {
    const door = liveDoor(shipped, { id: 12, role: roleFor(without([LV])), organization_id: 1 });
    const real = await door({ name: 'read_entity', input: { entity_type: 'lead', id: 'l1' } });
    const fake = await door({ name: 'read_entity', input: { entity_type: 'lead', id: 'l_nope' } });
    expect(real.error).toMatch(/^Permission denied/);
    expect(real).toEqual(fake);
    expect(JSON.stringify(real)).not.toMatch(/l1|Waterside/);
  });

  test('search_entities{user} for a matching filter and a non-matching one', async () => {
    const door = liveDoor(shipped, { id: 11, role: roleFor([LV]), organization_id: 1 });
    const hit = await door({ name: 'search_entities', input: { entity_type: 'user', filter: 'jake' } });
    const miss = await door({ name: 'search_entities', input: { entity_type: 'user', filter: 'zzzz' } });
    expect(hit.error).toMatch(/^Permission denied/);
    expect(hit).toEqual(miss);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 6. MUTATIONS — each new guard removed, the same drive shown to leak
 * ══════════════════════════════════════════════════════════════════════════*/
describe('the new guards are load-bearing', () => {
  test("RED mutant: without case 'user', a LEADS_VIEW-only user reads the staff roster", async () => {
    const m = load([["    case 'user':          return ['JOBS_VIEW_ALL', 'ESTIMATES_VIEW'];\n", '']]);
    expect(m.internals.aiToolRequiredCapability('search_entities', { entity_type: 'user' })).toBeNull();
    const door = liveDoor(m, { id: 11, role: roleFor([LV]), organization_id: 1 });
    const r = await door({ name: 'search_entities', input: { entity_type: 'user', filter: 'a' } });
    expect(r.error).toBeUndefined();
    expect(r.summary).toContain('Jake Jobsonly (jake@agx.test)');
  });

  test.each([
    ["    case 'purchase_order': return 'JOBS_VIEW_ALL';   // read_purchase_orders\n", 'purchase_order', 'read_purchase_orders'],
    ["    case 'change_order':   return 'JOBS_VIEW_ALL';   // read_change_orders\n", 'change_order', 'read_change_orders'],
    ["    case 'project':        return 'JOBS_VIEW_ALL';   // read_projects\n", 'project', 'read_projects'],
    ["    case 'assembly':       return 'ESTIMATES_VIEW';  // read_assemblies, read_assembly_taxonomy\n", 'assembly', 'read_assemblies'],
  ])('RED mutant: without that fold case, search_entities is ungated while its narrow reader stays gated (%#)', (line, et, narrow) => {
    const m = load([[line, '']]);
    expect(m.internals.aiToolRequiredCapability('search_entities', { entity_type: et })).toBeNull();
    expect(m.internals.aiToolRequiredCapability(narrow, {})).not.toBeNull();
    expect(m.internals.aiToolCapabilityDenial('search_entities', { entity_type: et }, userWith([]))).toBeNull();
  });

  test('RED mutant: without the blank-filters refusal, JOBS_VIEW_ALL alone reads the WIP roll-up', async () => {
    const m = load([[
      "          if (!q && gateSawFilter &&\n" +
      "              aiToolCapabilityDenial('search_entities', { entity_type: 'job' }, ctx && ctx.user)) {\n" +
      "            return Promise.resolve(\n" +
      "              'search_entities(job): every value in filters was blank, so nothing was searched. ' +\n" +
      "              'Pass a non-blank job name or number, or omit filter/filters entirely for the WIP roll-up.'\n" +
      "            );\n" +
      "          }\n",
      '',
    ]]);
    const door = liveDoor(m, { id: 12, role: roleFor([JVA]), organization_id: 1 });
    const plain = await door({ name: 'search_entities', input: { entity_type: 'job' } });
    expect(plain.error).toMatch(/lacks the FINANCIALS_VIEW capability/);
    const r = await door({ name: 'search_entities', input: { entity_type: 'job', filters: [''] } });
    expect(String(r.summary)).toContain('WIP ROLL-UP');
  });

  test('RED mutant: without the entitlement clause, a FINANCIALS_VIEW holder loses the roll-up', async () => {
    const m = load([[
      "          if (!q && gateSawFilter &&\n" +
      "              aiToolCapabilityDenial('search_entities', { entity_type: 'job' }, ctx && ctx.user)) {\n",
      "          if (!q && gateSawFilter) {\n",
    ]]);
    const door = liveDoor(m, { id: 12, role: roleFor(ALL_CAPS), organization_id: 1 });
    const r = await door({ name: 'search_entities', input: { entity_type: 'job', filters: [''] } });
    expect(String(r.summary)).toMatch(/^search_entities\(job\): every value in filters was blank/);
  });

  test('RED mutant: charging the blank shape the roster price lets JOBS_VIEW_ALL alone through', async () => {
    const m = load([[
      "aiToolCapabilityDenial('search_entities', { entity_type: 'job' }, ctx && ctx.user)) {",
      "aiToolCapabilityDenial('search_entities', { entity_type: 'job', filter: 'x' }, ctx && ctx.user)) {",
    ]]);
    const door = liveDoor(m, { id: 12, role: roleFor([JVA]), organization_id: 1 });
    const r = await door({ name: 'search_entities', input: { entity_type: 'job', filters: [''] } });
    expect(String(r.summary)).toContain('WIP ROLL-UP');
  });
});
