// WHAT THE AGENTS ARE TOLD ABOUT SERVICE TICKETS — AND THAT IT IS TRUE.
//
// Each sentence pinned here replaced one that was false or silent, and each
// is checked against the code it describes rather than only against itself:
//
//   * 86 and the Assistant were told tickets can be read, and nothing said they
//     cannot be LISTED. No job read and no lead read lists a record's tickets
//     and search_entities has no ticket type, so a model asked "any tickets on
//     this job?" saw none and said none. They must say they cannot list them.
//   * "by its id or its ticket number" — nothing mints ticket_number, so a
//     lookup by number is a confident not-found.
//   * the Scribe was told job_id may be a $new_ ref to a job created in the same
//     payload. No payload creates a job.
//   * the Scribe's refusal list did not name `condition` or either side of
//     op:"move", both of which the dispatcher refuses for tickets as terminal.
//   * the payload title/summary become push titles and chat headers, and the
//     Scribe writes them freely — so they name the ticket by its title only.
//   * (1.35) the Scribe was told a task_adds entry takes assignee_user_id. A
//     building on a work order is never assigned to one person, and the
//     dispatcher now refuses that key BY NAME and TERMINALLY — so an instruction
//     the model could still read produced an unrecoverable turn rather than a
//     correctable one. The shape it prints is checked against the door itself.
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';

// admin-agents-routes.js (and ai-routes.js) arm timers AT MODULE LOAD whose
// handles are not stored; left real, a background refresh fires after the last
// test and logs into a finished run. Faking the clock across the require drops
// them — the same treatment agent-instruction-honesty.test.js uses.
jest.useFakeTimers();
const { AGENT_SYSTEM_BASELINE: B } = require('../server/routes/admin-agents-routes');
const dispatcher = require('../server/services/payload-dispatcher');
const internals = require('../server/routes/ai-routes-internals');
const subtaskDoor = require('../server/services/service-ticket-subtask-door');
const describeModule = require('../server/services/payload-describe');
jest.useRealTimers();

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const DESCRIBE_PATH = path.join(__dirname, '..', 'server', 'services', 'payload-describe.js');

// The Scribe's service_ticket bullet, and nothing after it — so a word found
// here is a word said ABOUT TICKETS, not somewhere else in a long prompt.
function scribeTicketBullet() {
  const s = B.scribe;
  const at = s.indexOf('  • service_ticket:');
  expect(at).toBeGreaterThan(-1);
  const end = s.indexOf('\n  • ', at + 5);
  return s.slice(at, end === -1 ? undefined : end);
}

function refusal(target) {
  try { dispatcher.validateTarget(target, 0); } catch (e) { return e; }
  return null;
}
const upd = (ops) => ({ entity_type: 'service_ticket', entity_id: 'st_1', ops: Object.assign({ op: 'update' }, ops) });

describe('86 and the Assistant: tickets cannot be listed, and they say so', () => {
  test.each(['job', 'assistant'])('%s is told it cannot list a record\'s tickets, never to say there are none, and where to send the user', (key) => {
    const t = B[key];
    expect(t).toMatch(/NEVER say a job or lead has no tickets/);
    expect(t).toMatch(/cannot list/i);
    expect(t).toMatch(/Service Tickets tab/);
    expect(t).toMatch(/by its id only/);
  });

  test.each(['job', 'assistant'])('%s is never offered a ticket number as a way in', (key) => {
    expect(B[key]).not.toMatch(/ticket number/i);
  });

  test('the claim is TRUE: search_entities offers no ticket type, and read_entity reads one by id', () => {
    const tools = internals.readTools();
    const search = tools.find((t) => t.name === 'search_entities');
    const read = tools.find((t) => t.name === 'read_entity');
    expect(search.description).not.toMatch(/service_ticket/);
    expect(JSON.stringify(search.input_schema)).not.toMatch(/service_ticket/);
    expect(read.input_schema.properties.entity_type.enum).toContain('service_ticket');
    expect(read.description).not.toMatch(/ticket number/i);
  });
});

describe('the Scribe\'s service_ticket bullet', () => {
  test('job_id is a real job, never a $new_ ref — and it is TRUE that no payload creates a job', () => {
    const b = scribeTicketBullet();
    expect(b).toMatch(/never a `\$new_` ref, because no payload creates a job/);
    expect(b).not.toMatch(/`\$new_<name>` ref to a job/);
    expect(b).toMatch(/lead_id is a real lead id or a `\$new_<name>` ref to a lead created earlier in the same payload/);
    // No job op creates a row: the job grammar has no `op` key at all.
    expect([...dispatcher.PAYLOAD_OPS_SCHEMAS.job.allowedTopKeys]).not.toContain('op');
  });

  test('condition and either side of op:"move" are named as refused — and the dispatcher refuses both, terminally', () => {
    const b = scribeTicketBullet();
    const refused = b.slice(b.indexOf('- REFUSED'));
    expect(refused).toMatch(/a `condition` on a service_ticket target/);
    expect(refused).toMatch(/EITHER side \(source or dest\) of an `op:'move'`/);

    const cond = refusal(Object.assign(upd({ fields: { title: 'x' } }), { condition: 'upsert' }));
    expect(cond && cond.detail && cond.detail.retryable).toBe(false);
    for (const side of ['source', 'dest']) {
      const other = side === 'source' ? 'dest' : 'source';
      const mv = refusal({ op: 'move', [side]: upd({ fields: { title: 'a' } }),
        [other]: { entity_type: 'lead', entity_id: 'l1', ops: { op: 'update', fields: { title: 'b' } } } });
      expect(mv && mv.message).toMatch(new RegExp('move\\.' + side + ' cannot be a service_ticket target'));
      expect(mv.detail.retryable).toBe(false);
    }
  });

  test('the payload title and summary name the ticket by its title only', () => {
    const b = scribeTicketBullet();
    expect(b).toMatch(/payload `title` and `summary`[^\n]*TITLE ONLY — never its scope, its notes, the site contact's name or phone, or the address/);
  });
});

// ── 1.35: A BUILDING IS NEVER ASSIGNED TO ONE PERSON ──────────────────────
//
// The owner's rule, 2026-09-20: "whoever is assigned to the ticket, task or
// work order is evenly responsible." Responsibility sits on the RECORD —
// service_tickets.assignee_user_id — and a building on the punch list has no
// owner of its own and no picker anywhere in the app.
//
// The prompt was the last place still teaching otherwise, and it was the worst
// possible place. validateServiceTicketOps refuses task_adds[].assignee_user_id
// BY NAME, ticketRefusal stamps retryable:false, and a terminal service_ticket
// refusal is deliberately STICKY in ai-routes — every later tool use in the turn
// answers "that refusal is final and nothing was saved". validateOps runs AGAIN
// at apply time, so a payload already drafted and waiting for a tap becomes
// unapprovable. A Scribe obeying its own instructions while raising a work order
// with a punch list and crew names had no way out of the turn.
//
// So this block does not check the sentence against itself. The shape the prompt
// PRINTS is compared to the set the DOOR prints when it refuses an unknown key,
// both read out of the running code.
describe('the Scribe is not taught assignee_user_id on a building (1.35)', () => {
  // The task_adds GRAMMAR alone. Isolating it is the whole point: the word
  // assignee_user_id is still legitimate twice in this same bullet — on the WORK
  // ORDER's own fields, which is the one Assigned to that means anything — so a
  // bullet-wide `not.toMatch` would be both wrong and unshippable.
  function taskAddsKeys(text) {
    const m = String(text).match(/- task_adds: `\[\{([^}]*)\}\]`/);
    expect(m).not.toBeNull();
    return m[1].split(',')
      .map((s) => s.replace(/\(.*?\)/g, '').replace(/[?\s]/g, ''))
      .filter(Boolean);
  }

  // What the door TAKES, driven out of it rather than restated here: an unknown
  // key makes it print its whole accepted set. A key added to the grammar later
  // and not to the prompt fails without anyone remembering this file.
  function doorKeys() {
    const e = refusal(upd({ task_adds: [{ title: 'Building 7', not_a_real_key: 1 }] }));
    expect(e && e.detail && e.detail.code).toBe('unknown_field');
    return e.detail.expected.slice().sort();
  }

  test('the printed shape is exactly what the door accepts, and assignee_user_id is in neither', () => {
    const printed = taskAddsKeys(scribeTicketBullet());
    expect(printed.slice().sort()).toEqual(doorKeys());
    expect(printed).not.toContain('assignee_user_id');
    expect(doorKeys()).not.toContain('assignee_user_id');
  });

  test('THE MUTANT: the sentence that shipped fails this guard', () => {
    // Character for character what the baseline said before this fix.
    const was = '     - task_adds: `[{title, due_date? (DATE), assignee_user_id?, priority?, notes?}]` — child TASKS';
    expect(taskAddsKeys(was)).toContain('assignee_user_id');
    expect(taskAddsKeys(was).slice().sort()).not.toEqual(doorKeys());
  });

  test('the claim is TRUE and TERMINAL: refused by name, in the words every door uses', () => {
    const e = refusal(upd({ task_adds: [{ title: 'Building 7', assignee_user_id: 9 }] }));
    expect(e).not.toBeNull();
    expect(e.detail.code).toBe('building_not_assignable');
    // retryable:false is what made teaching this key so expensive: the Scribe
    // loop stops on the flag instead of prompting "fix it and re-emit".
    expect(e.detail.retryable).toBe(false);
    expect(e.message).toContain(subtaskDoor.MSG.notAssignable);
  });

  test('no spelling variant gets past it either — which is why the prompt names the RULE', () => {
    // A model told only "unknown field" tries another spelling. Each of these
    // is refused too, so the instruction has to say what is true rather than
    // leave the model to discover it five refusals later.
    for (const key of ['assignee', 'assigned_to', 'assignee_id', 'assigned_user_id', 'owner_user_id']) {
      const e = refusal(upd({ task_adds: [{ title: 'Building 7', [key]: 9 }] }));
      expect([key, e && e.detail && e.detail.code]).toEqual([key, 'unknown_field']);
    }
  });

  test('the prompt says the rule plainly, and says where responsibility does live', () => {
    const b = scribeTicketBullet();
    expect(b).toMatch(/A BUILDING IS NEVER ASSIGNED TO ONE PERSON/);
    expect(b).toMatch(/work order's OWN `fields\.assignee_user_id`/);
    expect(b).toMatch(/equally responsible for EVERY building on its punch list/);
    // And it is named in the REFUSED list — the one place the bullet already
    // says "do NOT retry, and do NOT drop or swap a field to get past one".
    const refused = b.slice(b.indexOf('- REFUSED'));
    expect(refused).toMatch(/`assignee_user_id` on a `task_adds` entry/);
  });

  test('every OTHER instruction is intact: a work order and an ordinary task are still assignable', () => {
    // The ticket's own Assigned to — the field the prompt now redirects to. If
    // this fix had taken it out, the redirect would point at nothing.
    expect(scribeTicketBullet()).toMatch(/assignee_user_id \(a real in-org user id\)/);
    expect(B.scribe).toMatch(/service_ticket\.fields:[^\n]*assignee_user_id/);
    expect(() => dispatcher.validateTarget({ entity_type: 'service_ticket', entity_id: 'st_1',
      ops: { op: 'update', fields: { assignee_user_id: 9 } } }, 0)).not.toThrow();
    // ORG tasks that are not buildings keep theirs. This rule is about the
    // punch list, not about assignment.
    expect(B.scribe).toMatch(/• task: [^\n]*assignee_user_id\?/);
  });
});

// ── THE APPROVAL CARD STOPS ADVERTISING IT ────────────────────────────────
//
// BAGS.ticketTask in payload-describe.js listed assignee_user_id under lowIds —
// the bag for "the op's own address or a harmless owner link" — so a task_add
// carrying an owner described as an ordinary low-risk change and auto-applied on
// a spoken yes. The key can no longer arrive through validateServiceTicketOps,
// but a describe bag is a second, quieter statement of the same rule, and it
// said the opposite of the door.
describe('the approval card no longer treats a building owner as harmless', () => {
  const ticket = (task) => ([{ entity_type: 'service_ticket',
    ops: { op: 'create', fields: { title: 'Roof leak', job_id: 'job_1' }, task_adds: [task] } }]);
  const WITH_OWNER = ticket({ title: 'Building 7', assignee_user_id: 9 });

  test('a task_add with the four real keys is LOW — the control', () => {
    expect(describeModule.classifyRisk(ticket({ title: 'Building 7', priority: 'high',
      notes: 'ridge cap', due_date: '2026-10-01' }))).toEqual({ risk: 'low', reasons: [] });
  });

  test('a task_add carrying an owner is click-only, and the line says what it is', () => {
    const r = describeModule.describePayload(WITH_OWNER, [], {});
    expect(r.reasons).toContain('link:assignee_user_id');
    expect(r.risk).toBe('high');
    expect(r.clickOnly).toBe(true);
    expect(r.line).toMatch(/re-link assignee user id/);
  });

  test('THE MUTANT: put assignee_user_id back in ticketTask lowIds and the card goes quiet', () => {
    // A real mutation of the shipped file, compiled in a child process under its
    // own filename — nothing on disk is touched (other agents are working in
    // this checkout) and no sibling module is involved, because payload-describe
    // requires none.
    const WAS = "ticketTask: bagSpec({ low: ['title', 'notes', 'priority', 'due_date'] })";
    const MUT = "ticketTask: bagSpec({ low: ['title', 'notes', 'priority', 'due_date'], lowIds: ['assignee_user_id'] })";
    expect(fs.readFileSync(DESCRIBE_PATH, 'utf8')).toContain(WAS);
    const script = `
      const Module = require('module');
      const fs = require('fs');
      const P = ${JSON.stringify(DESCRIBE_PATH)};
      const src = fs.readFileSync(P, 'utf8').replace(${JSON.stringify(WAS)}, ${JSON.stringify(MUT)});
      if (src.indexOf(${JSON.stringify(MUT)}) === -1) throw new Error('mutation did not apply');
      const real = Module._extensions['.js'];
      Module._extensions['.js'] = function (m, f) { return f === P ? m._compile(src, f) : real(m, f); };
      const m = require(P);
      process.stdout.write(JSON.stringify(m.classifyRisk(${JSON.stringify(WITH_OWNER)})));
    `;
    const out = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
    expect(out.stderr).toBe('');
    // With the bag entry back, an owner on a building reads as harmless again —
    // exactly the verdict this fix removed.
    expect(JSON.parse(out.stdout)).toEqual({ risk: 'low', reasons: [] });
  });
});

// ── 86'S READS STOP NAMING A PER-BUILDING OWNER (1.35) ────────────────────
//
// The prompt and the write doors above say a building is never assigned to one
// person. 86'S READS SAID THE OPPOSITE, in the same turn, out loud:
//
//   * readServiceTicketForAgent joined users on tasks.assignee_user_id and
//     printed a name beside every line of the punch list — a per-building
//     owner, four lines under the work order's real Assigned to;
//   * read_tasks' by-id arm (the one general task read that still answers with
//     a building) printed `Assignee: <that same column>`;
//   * read_tasks' list arm printed it too, and — worse — FILTERED on it, so
//     `{include_work_order_buildings:'1', assignee:'me'}` answered "the
//     buildings that name me" and dropped every other building on the list.
//
// Nothing sets tasks.assignee_user_id on a building and nothing else reads it,
// so every name those three places printed was residue an older release left
// behind: stale where a row had one, silent where it did not. A model relaying
// it told somebody they were not on the hook for a building that is exactly as
// much theirs as the one above it — which is the rule inverted, in prose, in
// the user's chat window.
//
// These run the SHIPPED executors against a real SQL engine (node:sqlite
// through the pg shim, over the schema server/db.js writes), because the
// property is held by the statement and the printer, not by their source. Each
// rule is then REMOVED from a copy of the shipped file and the identical drive
// is shown to produce the exact wrong answer it exists to prevent.
const os = require('os');
const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema } = require('./helpers/db-schema');

jest.setTimeout(60000);

const AI_ROUTES = path.join(__dirname, '..', 'server', 'routes', 'ai-routes.js');
const READ_TABLES = ['organizations', 'users', 'roles', 'jobs', 'job_access', 'leads', 'tasks',
  'attachments', 'service_tickets', 'service_ticket_participants', 'service_ticket_revisions',
  'service_ticket_shares', 'service_ticket_events',
  // Not read by anything under test — the context registry logs every read
  // fire-and-forget, and without the table each drive prints a warning that
  // buries the real output.
  'context_load_events'];

const OFFICE = 10;     // Wendy Wide  — the caller for most reads
const CARL = 20;       // Carl Crew   — THE RESIDUE: named on one building row
const DANA = 30;       // Dana Dispatch — the WORK ORDER's own Assigned to

let eng;
let OFFICE_CTX;
let CARL_CTX;
let readMutantPaths = [];

describe("86's reads name the work order's Assigned to, never a building's (1.35)", () => {
  beforeAll(async () => {
    eng = createPgSqlite(sqliteSchema(READ_TABLES), {
      jsonColumns: ['checklist', 'capabilities', 'detail', 'data', 'tags', 'materials',
        'notification_prefs', 'fields'],
    });
    const db = require('../server/db');
    db.pool.query = (sql, params) => eng.pool.query(sql, params);
    db.pool.connect = eng.pool.connect;
    const auth = require('../server/auth');
    auth.setRolePool(eng.pool);

    const caps = JSON.stringify(['JOBS_VIEW_ALL', 'JOBS_EDIT_ANY', 'LEADS_VIEW', 'LEADS_EDIT']);
    eng.db.exec(`
      INSERT INTO organizations (id, name, timezone) VALUES (1, 'AGX', 'America/New_York');
      INSERT INTO roles (name, capabilities) VALUES ('st_wide', '${caps}');
      INSERT INTO users (id, name, email, role, organization_id, active) VALUES
        (${OFFICE}, 'Wendy Wide',    'w@agx.test', 'st_wide', 1, 1),
        (${CARL},   'Carl Crew',     'c@agx.test', 'st_wide', 1, 1),
        (${DANA},   'Dana Dispatch', 'd@agx.test', 'st_wide', 1, 1);
      INSERT INTO jobs (id, owner_id, data, organization_id)
        VALUES ('j1', ${OFFICE}, '{"jobNumber":"24-118","title":"Latitude"}', 1);

      INSERT INTO service_tickets
        (id, organization_id, title, ticket_number, job_id, status, priority,
         assignee_user_id, checklist, materials, created_by)
        VALUES ('st1', 1, 'Latitude punch list', 'WO-1042', 'j1', 'in_progress', 'normal',
                ${DANA}, '[]', '[]', ${OFFICE});

      -- b1 carries a value an older release left on the row. NOTHING may read
      -- it: not the punch list, not the by-id read, not the filter. b2 carries
      -- none, and is exactly as much Dana's crew's work as b1.
      INSERT INTO tasks (id, organization_id, title, status, scope, kind, priority,
                         owner_user_id, assignee_user_id, service_ticket_id,
                         entity_type, entity_id, created_at)
        VALUES
        ('b1',    1, 'Bldg 1 — Side A',  'open', 'org', 'punch', 'normal', NULL, ${CARL}, 'st1', 'job', 'j1', '2026-09-01'),
        ('b2',    1, 'Bldg 2 — Side B',  'open', 'org', 'punch', 'normal', NULL, NULL,    'st1', 'job', 'j1', '2026-09-02'),
        ('plain', 1, 'Order the latch',  'open', 'org', 'todo',  'normal', NULL, ${CARL}, NULL,  'job', 'j1', '2026-09-03'),
        ('other', 1, 'Call the supplier','open', 'org', 'todo',  'normal', NULL, ${OFFICE}, NULL,'job', 'j1', '2026-09-04');
    `);
    await auth.refreshRoleCache();

    OFFICE_CTX = { userId: OFFICE, orgId: 1, user: { id: OFFICE, name: 'Wendy Wide', role: 'st_wide', organization_id: 1 } };
    // Carl's ROLE is beside the point — read_tasks is gated by the org, not by
    // a capability. He is here because he is the name on the residue.
    CARL_CTX = { userId: CARL, orgId: 1, user: { id: CARL, name: 'Carl Crew', role: 'st_wide', organization_id: 1 } };
  });

  afterEach(() => {
    for (const p of readMutantPaths) {
      try { delete require.cache[require.resolve(p)]; } catch (e) { /* never loaded */ }
      try { fs.unlinkSync(p); } catch (e) { /* already gone */ }
    }
    readMutantPaths = [];
  });

  afterAll(() => {
    require('../server/db').pool.query = async () => ({ rows: [], rowCount: 0 });
    if (eng) eng.close();
  });

  // ── mutant(): one rule removed from a copy of the shipped ai-routes.js ───
  // THE CRLF TRAP: this repo is core.autocrlf=true, so an LF-anchored replace
  // against CRLF bytes changes nothing and the "mutant" IS the shipped code —
  // a mutation test that passes having proved nothing. Normalise, refuse an
  // anchor that is absent or ambiguous, and refuse when no bytes moved.
  const BUILTINS = new Set(require('module').builtinModules);
  const absSlash = (p) => p.split(path.sep).join('/');
  const REPO_ROOT = path.join(__dirname, '..');

  function absolutizeRequires(src, fromDir) {
    return src.replace(/require\((['"])([^'"]+)\1\)/g, (m, q, spec) => {
      if (spec.charAt(0) === '.') return 'require(' + q + absSlash(path.resolve(fromDir, spec)) + q + ')';
      if (BUILTINS.has(spec) || spec.startsWith('node:')) return m;
      return 'require(' + q + absSlash(path.join(REPO_ROOT, 'node_modules', spec)) + q + ')';
    });
  }

  function mutant(pairs) {
    const src = fs.readFileSync(AI_ROUTES, 'utf8').replace(/\r\n/g, '\n');
    let out = src;
    for (const [find, replace] of pairs) {
      const hits = out.split(find).length - 1;
      if (hits !== 1) {
        throw new Error('MUTATION ANCHOR ' + (hits ? 'AMBIGUOUS (' + hits + ')' : 'NOT FOUND') +
          ': ' + find.slice(0, 120));
      }
      out = out.split(find).join(replace);
    }
    if (out === src) throw new Error('MUTATION CHANGED NO BYTES');
    const p = path.join(os.tmpdir(),
      '_p86_bldgread_' + process.pid + '_' + Math.random().toString(36).slice(2, 10) + '.js');
    fs.writeFileSync(p, absolutizeRequires(out, path.dirname(AI_ROUTES)), 'utf8');
    readMutantPaths.push(p);
    // ai-routes arms a setInterval at module load; faking the clock across the
    // require drops it so the worker can still exit.
    jest.useFakeTimers();
    try { return require(p).internals; } finally { jest.useRealTimers(); }
  }

  test('the mutation harness is real: a missing anchor throws, and the file is CRLF on disk', () => {
    expect(() => mutant([['this string is nowhere', 'x']])).toThrow('MUTATION ANCHOR NOT FOUND');
    expect(fs.readFileSync(AI_ROUTES, 'utf8').indexOf('\r\n')).toBeGreaterThan(-1);
  });

  // ── THE WORK ORDER'S OWN READ ────────────────────────────────────────────
  const readTicket = (internals_, ctx) => internals_.dispatchReadTool(
    'read_entity', { entity_type: 'service_ticket', id: 'st1', depth: 'full' }, ctx || OFFICE_CTX);

  describe("read_service_ticket's punch list", () => {
    test('names the work order\'s Assigned to, lists both buildings, and names no owner per line', async () => {
      const out = String(await readTicket(internals));
      // The one Assigned to that means anything — the RECORD's.
      expect(out).toContain('Assignee: Dana Dispatch');
      expect(out).toContain('Bldg 1 — Side A');
      expect(out).toContain('Bldg 2 — Side B');
      // …and the residue on b1 is not narrated anywhere.
      expect(out).not.toContain('Carl Crew');
    });

    test('the header says the rule once, so owner-less lines do not read as "unassigned"', async () => {
      const out = String(await readTicket(internals));
      expect(out).toMatch(/Tasks \(2\) — everyone this work order is assigned to is equally responsible/);
      expect(out).toMatch(/a building is never assigned to one person/);
    });

    test('THE MUTANT: put the join and the name back and the punch list prints a per-building owner', async () => {
      const m = mutant([
        [
          "    `SELECT k.id, k.title, k.status, k.due_date, k.completed_at, k.archived_at\n" +
          "       FROM tasks k\n" +
          "      WHERE k.service_ticket_id = $1",
          "    `SELECT k.id, k.title, k.status, k.due_date, k.completed_at, k.archived_at,\n" +
          "            ku.name AS assignee_name\n" +
          "       FROM tasks k\n" +
          "       LEFT JOIN users ku ON ku.id = k.assignee_user_id AND ku.organization_id = k.organization_id\n" +
          "      WHERE k.service_ticket_id = $1",
        ],
        [
          "        ' — ' + (k.status || 'open') + (kDue ? ', due ' + kDue : '') + '  [' + k.id + ']');",
          "        ' — ' + (k.status || 'open') + (kDue ? ', due ' + kDue : '') +\n" +
          "        (k.assignee_name ? ', ' + short(k.assignee_name, 120) : '') + '  [' + k.id + ']');",
        ],
      ]);
      const out = String(await readTicket(m));
      // Red: Bldg 1 belongs to Carl and Bldg 2 to nobody — the rule inverted.
      expect(out).toMatch(/Bldg 1 — Side A — open, Carl Crew/);
      expect(out).not.toMatch(/Bldg 2 — Side B — open, /);
    });

    test('the statement itself asks for no owner — no join on the building, no column to print', () => {
      const src = fs.readFileSync(AI_ROUTES, 'utf8').replace(/\r\n/g, '\n');
      const at = src.indexOf('WHERE k.service_ticket_id = $1');
      expect(at).toBeGreaterThan(-1);
      const stmt = src.slice(src.lastIndexOf('SELECT k.id', at), src.indexOf('LIMIT 100', at));
      expect(stmt).not.toMatch(/assignee/i);
      // …and every other predicate on it is exactly as it was.
      expect(stmt).toContain('k.organization_id = $2');
      expect(stmt).toContain("(k.scope = 'org' OR (k.scope = 'personal' AND k.owner_user_id = $3))");
      expect(stmt).not.toContain('notAWorkOrderBuildingSql');
    });
  });

  // ── THE BY-ID ARM — the one general task read that answers with a building ─
  describe("read_tasks' by-id arm", () => {
    const byId = (internals_, id) => internals_.dispatchReadTool(
      'read_entity', { entity_type: 'task', id }, OFFICE_CTX);

    test("a building names the WORK ORDER's Assigned to and says why", async () => {
      const out = String(await byId(internals, 'b1'));
      expect(out).toContain('Bldg 1 — Side A');
      expect(out).toContain('On work order: WO-1042 Latitude punch list  [st1]');
      expect(out).toContain("Work order's Assigned to: Dana Dispatch");
      // The read says it in the SAME words the write doors refuse with.
      expect(out).toContain(subtaskDoor.MSG.notAssignable);
      expect(out).not.toContain('Carl Crew');
      expect(out).not.toMatch(/^Assignee:/m);
    });

    test('a building with no residue at all reads the same — responsibility is on the record', async () => {
      const out = String(await byId(internals, 'b2'));
      expect(out).toContain("Work order's Assigned to: Dana Dispatch");
      expect(out).not.toContain('unassigned');
    });

    test('an ORDINARY task is untouched: it still prints its own assignee', async () => {
      const out = String(await byId(internals, 'plain'));
      expect(out).toContain('Assignee: Carl Crew');
      expect(out).not.toContain("Work order's Assigned to");
      expect(out).not.toContain(subtaskDoor.MSG.notAssignable);
    });

    test('THE MUTANT: stop asking whether the row is a building and Carl owns Bldg 1 again', async () => {
      const m = mutant([['        if (subtaskDoor.isWorkOrderSubtask(t)) {', '        if (false) {']]);
      const out = String(await byId(m, 'b1'));
      expect(out).toContain('Assignee: Carl Crew');
      expect(out).not.toContain("Work order's Assigned to");
    });
  });

  // ── THE LIST ARM — the filter, and the printed line ──────────────────────
  describe("read_tasks' list arm", () => {
    const list = (internals_, input, ctx) => internals_.dispatchReadTool(
      'read_tasks', input, ctx || OFFICE_CTX);

    test('with buildings on the list, an assignee filter is not applied — every building comes back', async () => {
      const out = String(await list(internals,
        { q: 'Bldg', include_work_order_buildings: '1', assignee: 'me' }, CARL_CTX));
      expect(out).toContain('id=b1');
      expect(out).toContain('id=b2');
    });

    test('…and a numeric assignee is dropped there too, not just "me"', async () => {
      const out = String(await list(internals,
        { q: 'Bldg', include_work_order_buildings: '1', assignee: String(CARL) }));
      expect(out).toContain('id=b1');
      expect(out).toContain('id=b2');
    });

    test("each building's line names the work order's Assigned to, never the row's", async () => {
      const out = String(await list(internals, { q: 'Bldg', include_work_order_buildings: '1' }));
      expect(out).toMatch(/Bldg 1 — Side A \[id=b1\][^\n]*· work order @Dana Dispatch/);
      expect(out).toMatch(/Bldg 2 — Side B \[id=b2\][^\n]*· work order @Dana Dispatch/);
      expect(out).not.toContain('@Carl Crew');
    });

    test('THE MUTANT: put the filter back and half the punch list disappears for the man on it', async () => {
      const m = mutant([[
        "      const assignee = includeBuildings ? '' : String((input && input.assignee) || '').trim();",
        "      const assignee = String((input && input.assignee) || '').trim();",
      ]]);
      const out = String(await list(m,
        { q: 'Bldg', include_work_order_buildings: '1', assignee: 'me' }, CARL_CTX));
      // Red: "the buildings that name me" — authoritative-looking, meaningless,
      // and it hides Bldg 2, which is just as much his.
      expect(out).toContain('id=b1');
      expect(out).not.toContain('id=b2');
    });

    test('THE MUTANT: put the printed owner back and the line names Carl', async () => {
      const m = mutant([[
        "          (subtaskDoor.isWorkOrderSubtask(t)\n" +
        "            ? ' · work order @' + (t.work_order_assignee_name || 'unassigned')\n" +
        "            : (t.assignee_name ? ' · @' + t.assignee_name : (t.assignee_user_id ? ' · @#' + t.assignee_user_id : ' · unassigned'))) +",
        "          (t.assignee_name ? ' · @' + t.assignee_name : (t.assignee_user_id ? ' · @#' + t.assignee_user_id : ' · unassigned')) +",
      ]]);
      const out = String(await list(m, { q: 'Bldg', include_work_order_buildings: '1' }));
      expect(out).toContain('· @Carl Crew');
      expect(out).toContain('· unassigned');
      expect(out).not.toContain('work order @');
    });

    // ── AND THE FILTER IS UNTOUCHED WHERE IT MEANS SOMETHING ───────────────
    test('an ordinary task list still filters by assignee — this rule is about buildings only', async () => {
      const mine = String(await list(internals, { assignee: 'me' }, CARL_CTX));
      expect(mine).toContain('id=plain');
      expect(mine).not.toContain('id=other');
      const theirs = String(await list(internals, { assignee: String(OFFICE) }));
      expect(theirs).toContain('id=other');
      expect(theirs).not.toContain('id=plain');
    });

    test('unassigned still means unassigned, and buildings are still off the default list', async () => {
      const none = String(await list(internals, { assignee: 'unassigned' }));
      // b2 has no assignee_user_id, but it is a BUILDING and not on this list.
      expect(none).not.toContain('id=b2');
      expect(String(await list(internals, { q: 'Bldg' }))).toBe('No tasks matched "Bldg".');
    });
  });
});
