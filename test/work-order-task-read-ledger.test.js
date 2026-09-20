// EVERY CODE PATH THAT READS `tasks` IS ON THIS LEDGER (1.33).
//
// The SELECT-side twin of test/work-order-task-path-ledger.test.js, which
// counts the WRITERS. This one counts the READERS, because 1.33 reversed the
// read half of the storage decision:
//
//   "service tickets are not to be confused with tasks, they are two different
//    things; the subtasks in a service ticket shouldn't show up on any task
//    lists separately."  — the owner, 2026-09
//
// A building on a punch list is still an ordinary row in `tasks` (the storage
// argument in server/db.js is unchanged and still right), but it is no longer
// a to-do, so it must not appear on a task list. The rule is one predicate,
// server/services/service-ticket-subtask-door.js notAWorkOrderBuildingSql, so
// the SQL and isWorkOrderSubtask beside it cannot drift apart.
//
// Removing buildings from the task lists is only safe because the people they
// are ASSIGNED to were given somewhere else to see them in the same release
// (GET /api/service-tickets/my-buildings, Service Tickets → My work, the My Day
// strip, and the work-orders morning digest's your_buildings section). If a new
// read drops buildings without that, somebody loses sight of work assigned to
// them. That is why a new reader has to stop and be classified here rather than
// inherit a default.
//
// Every file under server/ with a `FROM tasks` or `JOIN tasks` must be named
// below as one of:
//
//   'general'        this is a TASK LIST. Buildings MUST be excluded, and the
//                    entry's check proves the file really calls the predicate.
//   'ticket-scoped'  buildings are EXPECTED here: the read is pinned — to one
//                    work order, to one ticket's punch list, to one task id, or
//                    (the 1.33 replacement reads) joined to service_tickets and
//                    keyed on the assignee, which is a list OF BUILDINGS on
//                    purpose. The entry's check proves the pin is really there.
//
// One entry, server/services/org-reset.js, is a ticket-scoped entry marked
// `sweep`: it is the tenant wipe's own count and DELETE, pinned to nothing
// because it is not a list anybody reads — buildings are expected, and its
// check proves the shape that makes it a sweep instead.
//
// It reads source text on purpose: the question is WHO reads the table, and the
// answer has to include paths no drive has reached yet. The behaviour of each
// list is driven in test/work-order-task-doors.test.js,
// test/work-order-attention.test.js and test/service-ticket-workorder.test.js.
'use strict';

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const SERVER = path.join(REPO, 'server');
const READS_TASKS = /FROM\s+tasks\b|JOIN\s+tasks\b/i;
const READS_TASKS_G = /FROM\s+tasks\b|JOIN\s+tasks\b/gi;
const UNLISTED = 'A new code path READS tasks. Decide whether buildings belong in it — see ' +
  'server/services/service-ticket-subtask-door.js notAWorkOrderBuildingSql — then add it here.';

// The predicate, as a call or (for a statement assembled as source text) spelled
// out. Either spelling counts; a `general` file must carry one of them. Always
// asked of codeOnly() text: several of these files EXPLAIN in a comment why
// they do or do not exclude buildings, and a comment is not a predicate.
const EXCLUSION_CALL = /notAWorkOrderBuildingSql\s*\(/;
const EXCLUSION_LITERAL = /service_ticket_id IS NULL OR\s+\w*\.?scope = 'personal'/;

// What makes a read of `tasks` something other than a browsable task list.
const PINS = [
  // one work order, or one ticket's punch list ($n, ANY(), an alias's column,
  // or a pin built by concatenation inside the door module itself)
  /service_ticket_id\s*=\s*(\$\d|ANY\(|[A-Za-z_]\w*\.\w+|['"]?\s*\+)/i,
  /service_ticket_id\s+IS\s+NOT\s+NULL/i,
  // joined to the work orders themselves — a list OF BUILDINGS, which is what
  // /my-buildings and /building-counts exist to be
  /JOIN\s+service_tickets\b/i,
  // one row, by id
  /\bid\s*=\s*\$\d/i,
  /\bid\s*=\s*ANY\(\$/i,
  /\bid\s*=\s*[A-Za-z_]\w*\.entity_id\b/i,
];
// Enough of the statement after `FROM tasks` to carry its own WHERE.
const STATEMENT_WINDOW = 700;

function walk(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name.charAt(0) === '.') continue;
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.js$/.test(name)) out.push(full);
  }
  return out;
}

const rel = (full) => path.relative(REPO, full).split(path.sep).join('/');
// This repo mixes line endings; an assertion that spans a line break would
// otherwise be an assertion about the checkout.
const norm = (src) => src.replace(/\r\n/g, '\n');
// Line comments removed, newlines kept. Only for "does this file really apply
// the predicate": ai-routes.js, tasks-routes.js and service-ticket-routes.js
// all name notAWorkOrderBuildingSql in prose to explain where it does NOT go.
const codeOnly = (src) => norm(src).replace(/(^|[^:])\/\/[^\n]*/g, '$1');

// Every read of `tasks` in a file, each with enough text after it to show its
// own predicates.
function readStatements(src) {
  const s = norm(src);
  const out = [];
  let m;
  READS_TASKS_G.lastIndex = 0;
  while ((m = READS_TASKS_G.exec(s))) out.push(s.slice(m.index, m.index + STATEMENT_WINDOW));
  return out;
}

const pinned = (stmt) => PINS.some((re) => re.test(stmt));

function between(src, start, end) {
  const a = src.indexOf(start);
  if (a < 0) return null;
  const b = src.indexOf(end, a + start.length);
  return src.slice(a, b < 0 ? src.length : b);
}

// The source of one express handler: from its declaration to the next
// top-level `router.` line (or the exports).
function handler(src, declaration) {
  const at = src.indexOf(declaration);
  if (at < 0) return null;
  const rest = src.slice(at + declaration.length);
  const next = rest.search(/\n(router\.|module\.exports)/);
  return declaration + (next < 0 ? rest : rest.slice(0, next));
}

const excludes = (src) => EXCLUSION_CALL.test(codeOnly(src)) || EXCLUSION_LITERAL.test(codeOnly(src));

function needsExclusion(src, label) {
  return excludes(src) ? [] : [label + ' does not exclude work-order buildings'];
}

// Each entry: whether buildings belong in this file's reads, why, and what must
// stay true of it. check(src) returns a list of problems (empty when it holds).
const FULL_LEDGER = {
  // ── general: task lists, which must subtract the buildings ───────────────
  'server/reminders-cron.js': {
    kind: 'general',
    why: 'The daily task-due email. It is a list of what is on a person\'s plate, so a building is not on it — the work-orders morning digest carries those instead, keyed on assignment rather than on job access.',
    check(src) {
      const fn = between(src, 'async function gatherTaskDigests(', '\n}\n');
      if (!fn) return ['gatherTaskDigests not found'];
      const problems = needsExclusion(fn, 'the task-due digest');
      // Side fix that shipped with the same rule: the statement joins users and
      // organizations and never asked whether they were the task's own.
      if (!/t\.organization_id = u\.organization_id/.test(fn)) {
        problems.push('the task-due digest lost its organization predicate');
      }
      return problems;
    },
  },
  'server/routes/tasks-routes.js': {
    kind: 'general',
    why: 'GET /api/tasks is THE task list — My Tasks, Team Tasks, My Day, the schedule and every entity Tasks panel read it. It subtracts the buildings; GET /api/tasks/:id deliberately does not, so the assignee opened from My work can still reach one.',
    check(src) {
      const list = handler(src, "router.get('/', requireAuth");
      if (!list) return ['the list handler was not found'];
      const problems = needsExclusion(list, 'GET /api/tasks');
      // A building must stay reachable BY ID: that is how the crew lead opens
      // one from My work, and how the office opens one from a notice.
      const byId = handler(src, "router.get('/:id', requireAuth");
      if (!byId) problems.push('the by-id handler was not found');
      else if (excludes(byId)) {
        problems.push('GET /api/tasks/:id now hides a building — the assignee has no way to open it');
      }
      return problems;
    },
  },
  'server/routes/ai-routes.js': {
    kind: 'general',
    why: '86 reads tasks four ways. Two are task lists and take the exclusion (read_tasks\' list arm, which search_entities and read_entity delegate to, and buildTodayDigest, injected on the first turn of every session). Two must NOT: the by-id detail arm, and readServiceTicketForAgent\'s punch list, which is the one read where buildings belong.',
    check(src) {
      const problems = [];
      const digest = between(src, 'async function buildTodayDigest(', '\n}\n');
      if (!digest) problems.push('buildTodayDigest not found');
      else problems.push(...needsExclusion(digest, "86's today digest"));

      const LIST_ARM = '// ── filtered list (search_entities) ──';
      const list = between(src, LIST_ARM, 'const r = await pool.query(sql, params);');
      if (!list) problems.push("read_tasks' list arm not found");
      else problems.push(...needsExclusion(list, "read_tasks' list arm"));

      const byId = between(src, '// ── single-task detail (read_entity by id) ──', LIST_ARM);
      if (!byId) problems.push("read_tasks' by-id arm not found");
      else if (excludes(byId)) {
        problems.push('the by-id arm now hides a building — it is ticket-agnostic on purpose');
      }

      const ticket = between(src, 'async function readServiceTicketForAgent(', '\n}\n');
      if (!ticket) problems.push('readServiceTicketForAgent not found');
      else {
        if (excludes(ticket)) {
          problems.push("readServiceTicketForAgent's punch list now excludes the buildings it exists to show");
        }
        if (!/k\.service_ticket_id = \$1/.test(ticket)) {
          problems.push("readServiceTicketForAgent's punch list is no longer pinned to one ticket");
        }
      }
      return problems;
    },
  },

  // ── ticket-scoped: buildings are expected ────────────────────────────────
  'server/routes/service-ticket-routes.js': {
    kind: 'ticket-scoped',
    why: 'The work order\'s own reads: the punch-list counts on every board row, the punch list on the detail read, and the 1.33 replacements — /my-buildings and /building-counts, which are lists OF BUILDINGS keyed on the assignee, not on listVisibility.',
    check(src) {
      const problems = [];
      const detail = between(src, 'SELECT id, title, status, due_date, assignee_user_id, completed_at, archived_at', 'ORDER BY created_at ASC');
      if (!detail || !/service_ticket_id = \$1/.test(detail)) {
        problems.push("the ticket detail's punch list is no longer pinned to one ticket");
      }
      const counts = between(src, 'const taskCountCols =', 'AS task_done');
      if (!counts || (counts.match(/k\.service_ticket_id = t\.id/g) || []).length !== 2) {
        problems.push('the per-row punch-list counts are no longer pinned to their own ticket');
      }
      // BLOCKING 1: the replacement must never be gated on job access.
      const mine = handler(src, "router.get('/my-buildings', requireAuth");
      if (!mine) problems.push('GET /my-buildings not found');
      else {
        if (mine.indexOf('myOpenBuildingSql(') < 0) problems.push('/my-buildings no longer asks the assignee-based door');
        if (/listVisibility\(/.test(mine)) problems.push('/my-buildings is gated on job access — a crew lead would see nothing');
      }
      return problems;
    },
  },
  'server/routes/service-ticket-share-routes.js': {
    kind: 'ticket-scoped',
    why: "The crew link's punch list. Pinned to the shared ticket, and org rows only: a bearer token has no owner, so a PM's private to-do that happens to carry the ticket id is never sent down it.",
    check(src) {
      const stmt = between(src, 'SELECT id, title, status, due_date, completed_at FROM tasks', 'ORDER BY created_at ASC');
      if (!stmt) return ['the crew punch-list read was not found'];
      const problems = [];
      if (!/service_ticket_id = \$1/.test(stmt)) problems.push('the crew punch list is no longer pinned to one ticket');
      if (!/scope = 'org'/.test(stmt)) problems.push("the crew punch list lost `scope = 'org'`");
      return problems;
    },
  },
  'server/routes/task-share-routes.js': {
    kind: 'ticket-scoped',
    why: 'A task link sent to a sub: every read is one task BY ID, never a list, so a building is reachable through a link that was already minted. Minting a NEW link on a building is refused in the POST handler instead.',
    check(src) {
      const problems = [];
      readStatements(src).forEach(function (stmt, i) {
        if (!pinned(stmt)) problems.push('the task-link read #' + (i + 1) + ' is no longer one task by id');
      });
      if (!/send the work-order link/.test(src)) {
        problems.push('minting a task link on a building is no longer refused');
      }
      return problems;
    },
  },
  'server/routes/attachment-routes.js': {
    kind: 'ticket-scoped',
    why: 'Two reads, neither a list: isBuildingAssignee asks one task who it is assigned to (the crew photo rule), and the recent-attachments feed asks whether one attachment hangs off a building so it can leave completion photos out.',
    check(src) {
      const problems = [];
      const assignee = between(src, 'async function isBuildingAssignee(', '\n}\n');
      if (!assignee || !/FROM tasks WHERE id = \$1 AND organization_id = \$2/.test(assignee)) {
        problems.push('isBuildingAssignee is no longer one task by id, in the caller\'s own org');
      }
      const feed = between(src, 'NOT EXISTS (SELECT 1 FROM tasks t', 'ORDER BY a.uploaded_at DESC');
      if (!feed || !/t\.service_ticket_id IS NOT NULL/.test(feed)) {
        problems.push('the recent-attachments feed no longer tests for a building');
      }
      return problems;
    },
  },
  'server/services/service-ticket-subtask-door.js': {
    kind: 'ticket-scoped',
    why: 'THE predicate module. notAWorkOrderBuildingSql is the exclusion every general list above asks for, and myOpenBuildingSql is the assignee-based replacement — its EXISTS reads tasks pinned to the ticket and to the ticket\'s own organization.',
    check(src) {
      const problems = [];
      const fn = between(src, 'function myOpenBuildingSql(', '\n}\n');
      if (!fn) return ['myOpenBuildingSql not found'];
      for (const need of ['wob.service_ticket_id', 'wob.organization_id', "wob.scope = 'org'", 'wob.assignee_user_id']) {
        if (fn.indexOf(need) < 0) problems.push('myOpenBuildingSql lost ' + need);
      }
      // BLOCKING 1 again, at the source: assignment is the only key.
      if (/listVisibility|myTicketRelationSql/.test(fn)) {
        problems.push('myOpenBuildingSql is no longer assignee-based');
      }
      const neg = between(src, 'function notAWorkOrderBuildingSql(', '\n}\n');
      if (!neg) problems.push('notAWorkOrderBuildingSql not found');
      else if (neg.indexOf("scope = 'personal'") < 0) {
        problems.push('notAWorkOrderBuildingSql lost its personal arm — a private to-do on a ticket would vanish from its owner\'s list');
      }
      return problems;
    },
  },
  'server/services/work-order-attention.js': {
    kind: 'ticket-scoped',
    why: 'Two per-ticket groups for the morning digest: the done/total tally on every row, and the your_buildings group — how many of the recipient\'s own buildings are open on each work order, which is what the digest tells a crew lead now that no task list will.',
    check(src) {
      const problems = [];
      readStatements(src).forEach(function (stmt, i) {
        if (!pinned(stmt)) problems.push('the attention read #' + (i + 1) + ' is no longer pinned to the tickets in hand');
      });
      const mine = between(src, 'SELECT k.service_ticket_id AS ticket_id, k.assignee_user_id AS user_id', 'GROUP BY k.service_ticket_id, k.assignee_user_id');
      if (!mine) problems.push('the your_buildings group was not found');
      else {
        for (const need of ['k.organization_id = $1', "k.scope = 'org'", "k.status <> 'done'", 'k.assignee_user_id IS NOT NULL']) {
          if (mine.indexOf(need) < 0) problems.push('the your_buildings group lost ' + need);
        }
      }
      if (src.indexOf("'your_buildings'") < 0) problems.push('the your_buildings section is gone — the digest stopped telling assignees');
      return problems;
    },
  },
  'server/services/service-ticket-workorder.js': {
    kind: 'ticket-scoped',
    why: 'THE work order: loadSubtask reads one building of one ticket, and the recount counts that ticket\'s punch list. Both are the ticket\'s own rows by definition.',
    check: pinnedReads('the work-order read'),
  },
  'server/services/work-order-review.js': {
    kind: 'ticket-scoped',
    why: 'Review & approve: Send back reads the buildings it is about to reopen, by id and on the ticket it holds.',
    check: pinnedReads('the send-back read'),
  },
  'server/services/work-order-notices.js': {
    kind: 'ticket-scoped',
    why: 'The crew-activity batch and the flag notice: the ticket\'s done/total tally, and the titles of the buildings the crew touched — all on the ticket in hand.',
    check: pinnedReads('the notice read'),
  },
  'server/services/work-order-photo-guard.js': {
    kind: 'ticket-scoped',
    why: 'The completion-photo rule: loadWorkOrderTask reads one task by id and only when it IS a building (service_ticket_id IS NOT NULL).',
    check: pinnedReads('the photo-guard read'),
  },
  'server/services/service-ticket-notify.js': {
    kind: 'ticket-scoped',
    why: "The assignment notice's punch-list tally (\"3 of 8 buildings done\"), pinned to the ticket being announced.",
    check: pinnedReads('the notice tally'),
  },
  'server/services/service-ticket-print.js': {
    kind: 'ticket-scoped',
    why: 'The printable work order lists the punch list it is printing, pinned to that ticket.',
    check: pinnedReads('the printable punch list'),
  },
  'server/services/service-ticket-change-order.js': {
    kind: 'ticket-scoped',
    why: 'A change order prefilled from a flagged building reads that ticket\'s buildings for their titles.',
    check: pinnedReads('the change-order read'),
  },
  'server/services/service-ticket-flags.js': {
    kind: 'ticket-scoped',
    why: 'The office flag list joins the flagged building for its title, matched on the flag\'s own ticket and organization.',
    check: pinnedReads('the flag-list join'),
  },
  'server/services/payload-dispatcher.js': {
    kind: 'ticket-scoped',
    why: "86's writer reads tasks by id only: which ids are on a work order (so an archive is blocked), who one is assigned to, and the after-snapshot of one it just added. It never lists tasks — read_tasks in ai-routes.js does that, and takes the exclusion.",
    check: pinnedReads("the dispatcher's read"),
  },
  'server/services/payload-draft-line.js': {
    kind: 'ticket-scoped',
    why: 'Label resolution for a draft line: the titles of ids the draft already names, read by id. A building named in a draft still needs its name shown.',
    check: pinnedReads('the label read'),
  },
  'server/services/org-reset.js': {
    kind: 'ticket-scoped',
    sweep: 'the tenant wipe: an org-wide count and DELETE, not a list anybody reads',
    why: 'Wipes or counts a whole organization. Buildings are org tasks and go with everything else; the read is pinned to nothing because it is not a list — it is the sweep\'s own count, scoped by the organization and the polymorphic anchor predicate.',
    check(src) {
      const problems = [];
      const stmts = readStatements(src);
      if (stmts.length !== 2) problems.push('expected the count and the DELETE, found ' + stmts.length + ' reads');
      stmts.forEach(function (stmt, i) {
        if (!/organization_id = \$1/.test(stmt)) problems.push('sweep read #' + (i + 1) + ' lost its organization predicate');
        if (!/scope = 'org'/.test(stmt)) problems.push('sweep read #' + (i + 1) + " lost `scope = 'org'` and would now count a private to-do");
        if (!/polyPred\(/.test(stmt)) problems.push('sweep read #' + (i + 1) + ' lost the anchor predicate');
      });
      return problems;
    },
  },
};

// Every read in the file must be pinned. The shared check for the modules whose
// only business with `tasks` is one work order's own rows.
function pinnedReads(label) {
  return function (src) {
    const problems = [];
    readStatements(src).forEach(function (stmt, i) {
      if (!pinned(stmt)) problems.push(label + ' #' + (i + 1) + ' is no longer pinned to a work order or to one task id');
    });
    return problems;
  };
}

// Pure: given files [{rel, src}] and a ledger, the census problems.
function census(files, ledger) {
  const LEDGER = ledger || FULL_LEDGER;
  const problems = [];
  const readers = new Set();
  for (const f of files) {
    if (!READS_TASKS.test(f.src)) continue;
    readers.add(f.rel);
    const entry = LEDGER[f.rel];
    if (!entry) { problems.push(f.rel + ': ' + UNLISTED); continue; }
    const src = norm(f.src);
    // The class-level rule, before anything the entry says about itself.
    if (entry.kind === 'general') {
      for (const p of needsExclusion(src, 'the file')) problems.push(f.rel + ': ' + p);
    } else if (!entry.sweep) {
      for (const stmt of readStatements(src)) {
        if (!pinned(stmt)) { problems.push(f.rel + ': a read of tasks here is not pinned — it may be a task list'); break; }
      }
    }
    for (const p of entry.check(src)) problems.push(f.rel + ': ' + p);
  }
  for (const [file, entry] of Object.entries(LEDGER)) {
    if (!readers.has(file) && !entry.optional) problems.push(file + ': on the ledger but no longer reads tasks — take it off');
  }
  return problems;
}

const FILES = walk(SERVER, []).map((full) => ({ rel: rel(full), src: fs.readFileSync(full, 'utf8') }));
const sourceOf = (file) => FILES.find((f) => f.rel === file).src;

// Replace a CRLF-normalised anchor that occurs exactly once.
function mutate(src, find, replace) {
  const s = norm(src);
  if (s.split(find).length !== 2) throw new Error('anchor not found: ' + find);
  return s.split(find).join(replace);
}
function withFile(file, src) {
  return FILES.map((f) => (f.rel === file ? { rel: f.rel, src } : f));
}

describe('the task-read census', () => {
  test('the walk really reaches the files that read tasks', () => {
    const readers = FILES.filter((f) => READS_TASKS.test(f.src)).map((f) => f.rel);
    expect(readers).toEqual(expect.arrayContaining([
      'server/reminders-cron.js', 'server/routes/ai-routes.js', 'server/routes/tasks-routes.js',
      'server/routes/service-ticket-routes.js', 'server/services/service-ticket-subtask-door.js',
      'server/services/work-order-attention.js', 'server/services/org-reset.js',
    ]));
    expect(FILES.length).toBeGreaterThan(100);
    // And nothing on the ledger is imaginary.
    expect(Object.keys(FULL_LEDGER).filter((f) => !readers.includes(f))).toEqual([]);
  });

  test('every file that reads tasks is on the ledger, and every entry holds', () => {
    expect(census(FILES)).toEqual([]);
  });

  test('every entry says why, and is classified', () => {
    for (const [file, entry] of Object.entries(FULL_LEDGER)) {
      expect([file, entry.why.length > 40]).toEqual([file, true]);
      expect([file, entry.kind]).toEqual([file, expect.stringMatching(/^(general|ticket-scoped)$/)]);
    }
  });

  test('the general entries are the task lists, and they are the ones that carry the predicate', () => {
    const general = Object.entries(FULL_LEDGER).filter(([, e]) => e.kind === 'general').map(([f]) => f).sort();
    expect(general).toEqual([
      'server/reminders-cron.js', 'server/routes/ai-routes.js', 'server/routes/tasks-routes.js',
    ]);
    for (const file of general) expect([file, excludes(sourceOf(file))]).toEqual([file, true]);
  });
});

describe('the census is not decoration', () => {
  test('a new file that reads tasks fails with the sentence that says what to do', () => {
    const files = FILES.concat([{
      rel: 'server/routes/crew-worklist-routes.js',
      src: "const r = await pool.query('SELECT id, title FROM tasks WHERE assignee_user_id = $1', [uid]);",
    }]);
    expect(census(files)).toEqual(['server/routes/crew-worklist-routes.js: ' + UNLISTED]);
  });

  test('a new file caught even when it only JOINs tasks', () => {
    const files = FILES.concat([{
      rel: 'server/services/crew-rollup.js',
      src: 'const sql = `SELECT u.name FROM users u JOIN tasks t ON t.assignee_user_id = u.id`;',
    }]);
    expect(census(files)).toEqual(['server/services/crew-rollup.js: ' + UNLISTED]);
  });

  test('taking a file off the ledger fails, and says the same thing', () => {
    const shrunk = Object.assign({}, FULL_LEDGER);
    delete shrunk['server/routes/tasks-routes.js'];
    expect(census(FILES, shrunk)).toEqual(['server/routes/tasks-routes.js: ' + UNLISTED]);
    expect(census(FILES)).toEqual([]);
  });

  test('an entry for a file that stopped reading tasks fails', () => {
    const files = FILES.filter((f) => f.rel !== 'server/services/service-ticket-print.js');
    expect(census(files)).toEqual(['server/services/service-ticket-print.js: on the ledger but no longer reads tasks — take it off']);
  });

  test('MUTANT: the daily task email drops the exclusion and buildings are back on it', () => {
    const file = 'server/reminders-cron.js';
    const src = mutate(sourceOf(file),
      "    '  AND ' + subtaskDoor.notAWorkOrderBuildingSql('t'),\n", '');
    expect(census(withFile(file, src))).toEqual(expect.arrayContaining([
      file + ': the file does not exclude work-order buildings',
      file + ': the task-due digest does not exclude work-order buildings',
    ]));
  });

  test('MUTANT: GET /api/tasks drops the exclusion and My Tasks lists buildings again', () => {
    const file = 'server/routes/tasks-routes.js';
    const src = mutate(sourceOf(file),
      "    if (!skipBuildingRule) where.push(subtaskDoor.notAWorkOrderBuildingSql('t'));\n", '');
    const out = census(withFile(file, src));
    expect(out).toContain(file + ': GET /api/tasks does not exclude work-order buildings');
  });

  test("MUTANT: 86's today digest drops the exclusion and recites buildings on the first turn", () => {
    const file = 'server/routes/ai-routes.js';
    const src = mutate(sourceOf(file),
      "      '   AND ' + subtaskDoor.notAWorkOrderBuildingSql('tasks') + ' ' +\n", '');
    expect(census(withFile(file, src))).toEqual([file + ": 86's today digest does not exclude work-order buildings"]);
  });

  test("MUTANT: 86's by-id read starts excluding buildings and a building becomes unreadable", () => {
    const file = 'server/routes/ai-routes.js';
    const src = mutate(sourceOf(file),
      "            WHERE t.id = $1 AND t.organization_id = $2 AND t.archived_at IS NULL\n",
      "            WHERE t.id = $1 AND t.organization_id = $2 AND t.archived_at IS NULL\n" +
      "              AND ${subtaskDoor.notAWorkOrderBuildingSql('t')}\n");
    expect(census(withFile(file, src))).toEqual([
      file + ': the by-id arm now hides a building — it is ticket-agnostic on purpose',
    ]);
  });

  test('MUTANT: the assignee door is gated on job access and the crew lead it exists for sees nothing', () => {
    const file = 'server/routes/service-ticket-routes.js';
    const src = mutate(sourceOf(file),
      "      ' AND ' + subtaskDoor.myOpenBuildingSql('t', '$2');\n",
      "      ' AND ' + access.listVisibility(req.user, null, 'read').sql;\n");
    const out = census(withFile(file, src));
    expect(out).toContain(file + ': /my-buildings no longer asks the assignee-based door');
    expect(out).toContain(file + ': /my-buildings is gated on job access — a crew lead would see nothing');
  });

  test('MUTANT: a ticket-scoped read loses its pin and becomes a company-wide building list', () => {
    const file = 'server/services/service-ticket-print.js';
    const src = mutate(sourceOf(file),
      '      WHERE service_ticket_id = $1 AND organization_id = $2 AND archived_at IS NULL',
      '      WHERE organization_id = $2 AND archived_at IS NULL');
    const out = census(withFile(file, src));
    expect(out).toContain(file + ': a read of tasks here is not pinned — it may be a task list');
    expect(out).toContain(file + ': the printable punch list #1 is no longer pinned to a work order or to one task id');
  });

  test("MUTANT: notAWorkOrderBuildingSql loses its personal arm and a PM's private to-do vanishes", () => {
    const file = 'server/services/service-ticket-subtask-door.js';
    const src = mutate(sourceOf(file),
      "  return '(' + t + '.service_ticket_id IS NULL OR ' + t + \".scope = 'personal')\";",
      "  return '(' + t + '.service_ticket_id IS NULL)';");
    expect(census(withFile(file, src))).toEqual([
      file + ": notAWorkOrderBuildingSql lost its personal arm — a private to-do on a ticket would vanish from its owner's list",
    ]);
  });

  test('MUTANT: the your_buildings group stops asking for the assignee and tells everyone about everything', () => {
    const file = 'server/services/work-order-attention.js';
    const src = mutate(sourceOf(file),
      "          AND k.status <> 'done' AND k.assignee_user_id IS NOT NULL",
      "          AND k.status <> 'done'");
    expect(census(withFile(file, src))).toEqual([
      file + ': the your_buildings group lost k.assignee_user_id IS NOT NULL',
    ]);
  });

  test('MUTANT: the tenant sweep stops saying scope and would wipe private to-dos', () => {
    const file = 'server/services/org-reset.js';
    const src = mutate(sourceOf(file),
      `    await del('tasks', "DELETE FROM tasks WHERE organization_id = $1 AND scope = 'org' AND " + polyPred(ALL4, incNull));`,
      `    await del('tasks', 'DELETE FROM tasks WHERE organization_id = $1 AND ' + polyPred(ALL4, incNull));`);
    expect(census(withFile(file, src))).toEqual([
      file + ": sweep read #2 lost `scope = 'org'` and would now count a private to-do",
    ]);
  });
});
