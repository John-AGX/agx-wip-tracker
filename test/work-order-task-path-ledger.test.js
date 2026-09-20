// EVERY CODE PATH THAT WRITES `tasks` IS ON THIS LEDGER (1.29).
//
// A building on a work order's punch list is an ordinary row in `tasks`. The
// rules that make a building done — a completion photo, a work order that is
// not approved or closed, the ticket following its buildings, a timeline line —
// live in services/service-ticket-workorder.js, and the doors that are not the
// work order ask services/service-ticket-subtask-door.js. 1.28 shipped with
// four doors (My Tasks, adding, archiving, task links) that wrote the row
// directly, and every rule was skippable through them. Nothing noticed, because
// nothing counted the writers.
//
// This file counts them. It walks server/ for a statement that inserts,
// updates or deletes `tasks`, and every file it finds must be named below with
// the reason it may, and — where the reason is "it goes through the door" — a
// check that the door call is really there. A new file that writes tasks fails
// with the sentence that says what to do.
//
// ── AND NOBODY PUTS A NAME ON A BUILDING (1.35) ───────────────────────────
//
// The owner, 2026-09-20: "i dont want assignments to individual buildings like
// that, whoever is assigned to the ticket, task or work order is evenly
// responsible." So responsibility sits on the RECORD —
// service_tickets.assignee_user_id, the Assigned to the office sets from a
// real dropdown — and everyone on it is equally responsible for every building
// on its punch list. tasks.assignee_user_id exists on a building row only
// because a building IS a task row; no screen ever offered to set it, and from
// 1.35 no writer may.
//
// That is a second question every entry has to answer, and `assignment` is
// where it answers it:
//
//   'refused'  an ordinary caller can hand this door an assignee, so it says
//              NO BY NAME — server/services/service-ticket-subtask-door.js
//              assignVerdict / MSG.notAssignable, one sentence every door
//              says the same way — and says it BEFORE its own write. Dropping
//              the value in silence and answering 200 is the failure this
//              classification exists to prevent: the caller believes the name
//              stuck.
//   'never'    the statement cannot carry an assignee at all. The entry's
//              check reads the columns it writes and proves none of them is
//              one.
//   'unreachable'  the writer DOES set an assignee, but a building can never
//              be the row it sets it on, because the rows it can reach are
//              fixed by the statement itself rather than by a caller. Saying
//              'refused' here would mean calling a door this writer has no
//              caller to refuse, and 'never' would be false. The entry's
//              check must PROVE the reachable set excludes buildings; an
//              entry that claims this and proves nothing fails like any other.
//
// An unclassified entry fails, for the same reason an unlisted file does: the
// next writer has to stop and answer rather than inherit a default.
//
// It reads source text on purpose: the question is WHO writes the table, and
// the answer has to include paths no drive has reached yet. The behaviour of
// each door is driven in test/work-order-task-doors.test.js,
// test/service-ticket-workorder.test.js and test/service-ticket-payload.test.js.
'use strict';

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const SERVER = path.join(REPO, 'server');
const WRITES_TASKS = /UPDATE\s+tasks\b|INSERT\s+INTO\s+tasks\b|DELETE\s+FROM\s+tasks\b/i;
const WRITES_TASKS_G = /UPDATE\s+tasks\b|INSERT\s+INTO\s+tasks\b|DELETE\s+FROM\s+tasks\b/gi;
const UNLISTED = 'A new code path writes tasks. Route work-order subtasks through server/services/service-ticket-subtask-door.js, then add it here.';
// The 1.35 half of the question, and the sentences the census answers it with.
const UNCLASSIFIED = 'This writer does not say whether a name can reach a building through it. A building is never assigned to one person — see server/services/service-ticket-subtask-door.js assignVerdict — so classify it \'refused\' or \'never\' here.';
const NOT_REFUSED = 'it can be handed an assignee for a building and no longer refuses one BY NAME — subtaskDoor.assignVerdict is the one sentence every door says';
const WRITES_OWNER = "it writes an assignee onto a task row, and it was classified 'never' — a building is never assigned to one person";
const REFUSES_ASSIGNMENT = /subtaskDoor\.assignVerdict\(|subtaskDoor\.MSG\.notAssignable/;
const NO_PROOF = "it is classified 'unreachable' and supplies no provesUnreachable() — the claim that a building cannot be one of its rows has to be proved from the statements themselves";

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
const norm = (src) => src.replace(/\r\n/g, '\n');

// The source of one express handler: from its declaration to the next
// top-level `router.` line (or the exports).
function handler(src, declaration) {
  const at = src.indexOf(declaration);
  if (at < 0) return null;
  const rest = src.slice(at + declaration.length);
  const next = rest.search(/\n(router\.|module\.exports)/);
  return declaration + (next < 0 ? rest : rest.slice(0, next));
}

function between(src, start, end) {
  const a = src.indexOf(start);
  if (a < 0) return null;
  const b = src.indexOf(end, a + start.length);
  return src.slice(a, b < 0 ? src.length : b);
}

// What each statement PUTS INTO a row: from the verb to its first WHERE or
// RETURNING, which is the whole of where a value can land. A statement that
// assembles its columns at runtime (cols.join) shows none here — which is why
// those doors are classified 'refused' and answer for themselves instead.
function writtenColumns(src) {
  const s = norm(src);
  const out = [];
  let m;
  WRITES_TASKS_G.lastIndex = 0;
  while ((m = WRITES_TASKS_G.exec(s))) {
    const rest = s.slice(m.index, m.index + 600);
    const stop = rest.search(/\bWHERE\b|\bRETURNING\b/i);
    out.push(stop < 0 ? rest : rest.slice(0, stop));
  }
  return out;
}

// Each entry: why this file may write tasks, and what must stay true of it.
// check(src) returns a list of problems (empty when the entry holds). `optional`
// entries may stop writing tasks without failing the ledger.
const LEDGER = {
  'server/services/clickr/sync-apply.js': {
    why: 'The Buildertrend sync. Creates an org task against a linked P86 job, and updates one it created, from the Buildertrend Tasks dataset.',
    // It DOES write assignee_user_id, from a Buildertrend name resolved to
    // exactly one user of this organisation. It has no caller to refuse: the
    // rows it can reach are fixed by its own statements, and none of them is a
    // building.
    assignment: 'unreachable',
    provesUnreachable(src) {
      const problems = [];
      const ins = between(src, 'INSERT INTO tasks (', ');');
      if (!ins) { problems.push('the task INSERT was not found'); return problems; }
      // A building is a task under a service ticket. This row is anchored to a
      // JOB by literals, so it cannot be born as one.
      if (ins.indexOf("'job', $2, 'org'") < 0) problems.push('the INSERT no longer anchors the row to a job with literal entity_type and scope');
      if (/service_ticket_id/.test(ins)) problems.push('the INSERT now names service_ticket_id — it could create a work-order building');
      // And it cannot REACH one: every row it updates came from the preview
      // read, which excludes buildings by three predicates of its own (see the
      // entry for sync-preview.js in the read census).
      for (const stmt of src.match(/UPDATE\s+tasks\b[^;]*/gi) || []) {
        if (!/organization_id = \$\d+/.test(stmt)) problems.push('a tasks UPDATE lost its organization predicate');
        if (!/WHERE\s+id = \$\d+/.test(stmt)) problems.push('a tasks UPDATE is no longer pinned to one row by id');
      }
      return problems;
    },
    check(src) {
      const problems = [];
      const ins = between(src, 'INSERT INTO tasks (', ');');
      if (ins && ins.indexOf('SELECT organization_id FROM jobs WHERE id = $2') < 0) {
        problems.push('the INSERT no longer takes its organisation from the job it hangs on');
      }
      return problems;
    },
  },
  'server/services/service-ticket-workorder.js': {
    why: 'THE door: setSubtaskDone completes or reopens a building under the ticket lock.',
    // Its one statement sets status, completed_at and updated_at, spelled out
    // in the source rather than assembled, so writtenColumns above can read
    // the whole of what it puts into the row.
    assignment: 'never',
    check(src) {
      const problems = [];
      const body = between(src, 'async function applySubtaskDone(', '\n}\n');
      if (!body || !/UPDATE tasks/.test(body)) problems.push('the task UPDATE is not inside applySubtaskDone');
      if (!/return withTicketLock\(db, opts\.ticket,/.test(src)) problems.push('setSubtaskDone no longer runs under withTicketLock');
      if (!body || !/organization_id = \$4/.test(body)) problems.push('the task UPDATE lost its organization predicate');
      return problems;
    },
  },
  'server/routes/tasks-routes.js': {
    why: 'My Tasks and the job Tasks panel. Create, edit and archive go through the subtask door for work-order buildings.',
    // Both write doors assemble their columns from the body, so either could
    // put a name on a building. Each refuses one by name instead — POST when
    // a new org task is created ON a ticket, PATCH on the row as it ENDS UP,
    // which is what catches a plain task and an assignee arriving together.
    assignment: 'refused',
    check(src) {
      const problems = [];
      for (const [label, decl, needs] of [
        ['POST', "router.post('/', requireAuth", ['subtaskDoor.lockTickets', 'subtaskDoor.structureVerdict', 'workOrder.recountTicket']],
        ['PATCH', "router.patch('/:id', requireAuth", ['subtaskDoor.lockTickets', 'subtaskDoor.taskShifted', 'subtaskDoor.doneVerdict', 'subtaskDoor.structureVerdict', 'subtaskDoor.assignVerdict', 'workOrder.setSubtaskDone', 'workOrder.recountTicket']],
        ['DELETE', "router.delete('/:id', requireAuth", ['subtaskDoor.isWorkOrderSubtask', 'subtaskDoor.structureVerdict', 'workOrder.recountTicket']],
      ]) {
        const h = handler(src, decl);
        if (!h) { problems.push(label + ' handler not found'); continue; }
        for (const n of needs) if (h.indexOf(n + '(') < 0) problems.push(label + ' no longer calls ' + n);
      }
      // AND THE REFUSAL SITS BEFORE THE WRITE (1.35). Present is not enough:
      // a refusal reached after the row is written is a row with a name on it
      // and a 409 on top.
      for (const [label, decl, write] of [
        ['POST', "router.post('/', requireAuth", 'INSERT INTO tasks'],
        ['PATCH', "router.patch('/:id', requireAuth", "'UPDATE tasks SET '"],
      ]) {
        const h = handler(src, decl);
        if (!h) continue;
        const refusal = h.indexOf('subtaskDoor.assignVerdict(');
        const writeAt = h.indexOf(write);
        if (refusal < 0) problems.push(label + ' no longer refuses an assignee on a building');
        else if (writeAt >= 0 && refusal > writeAt) {
          problems.push(label + ' refuses an assignee on a building only after it has written the row');
        }
      }
      return problems;
    },
  },
  'server/routes/task-share-routes.js': {
    why: 'A task link sent to a sub. Done-ness on a work-order building goes through workOrder.setSubtaskDone with the crew gate.',
    // This door never wrote assignee_user_id — its sets are checklist, note and
    // status — so an assignee sent down a link was DROPPED and the caller told
    // 200. 1.35 refuses it by name instead, and only for a building: on an
    // ordinary shared task the field is ignored exactly as it always was.
    assignment: 'refused',
    check(src) {
      const problems = [];
      const h = handler(src, "router.patch('/task-share/:token', loadShare");
      if (!h) return ['PATCH handler not found'];
      const refusal = h.indexOf('subtaskDoor.assignVerdict(');
      if (refusal < 0) problems.push('PATCH no longer refuses an assignee on a building');
      else {
        const writeAt = h.indexOf("'UPDATE tasks SET '");
        if (writeAt >= 0 && refusal > writeAt) {
          problems.push('PATCH refuses an assignee on a building only after it has written the row');
        }
      }
      if (h.indexOf('workOrder.setSubtaskDone(') < 0) problems.push('PATCH no longer calls workOrder.setSubtaskDone');
      if (h.indexOf('gate: subtaskDoor.crewGate') < 0) problems.push('PATCH no longer passes the crew gate');
      if (h.indexOf('workOrder.withTicketLock(') < 0 || h.indexOf('subtaskDoor.taskShifted(') < 0) {
        problems.push('PATCH no longer decides on the task row under the ticket lock');
      }
      const photo = handler(src, "router.post('/task-share/:token/photo', loadShare");
      if (!photo || photo.indexOf('subtaskDoor.crewGate(') < 0) problems.push('the photo door no longer asks the crew gate');
      return problems;
    },
  },
  'server/services/payload-dispatcher.js': {
    why: '86: task/todo creates (never on a ticket — TASK_FIELDS has no service_ticket_id) and service_ticket task_adds, which are refused on an approved ticket and followed by recountTicket.',
    // The Scribe writes its columns from an approved payload, so a task_adds
    // entry could carry a name. assignee_user_id left the readable keys in
    // 1.35 and is refused BY NAME rather than falling into "unknown field",
    // which reads like a typo and invites a spelling variant of the refused
    // thing.
    assignment: 'refused',
    check(src) {
      const problems = [];
      const fn = between(src, 'async function dispatchServiceTicket(', '\nconst DISPATCHERS = {');
      if (!fn) return ['dispatchServiceTicket not found'];
      const ins = fn.indexOf('INSERT INTO tasks');
      const recount = fn.indexOf('workOrder.recountTicket(');
      if (ins < 0) problems.push('task_adds INSERT not found');
      if (recount < 0 || recount < ins) problems.push('recountTicket does not run after the task_adds INSERT');
      if (fn.indexOf('subtaskStructureWritable(') < 0 || fn.indexOf('subtaskStructureWritable(') > ins) {
        problems.push('the approved-ticket refusal does not run before the task_adds INSERT');
      }
      const task = between(src, 'const TASK_FIELDS = new Set([', ']);');
      if (!task || /service_ticket_id/.test(task)) problems.push('a plain 86 task can now be put on a work order without the door');
      const keys = between(src, 'const SERVICE_TICKET_TASK_KEYS = new Set([', ']);');
      if (!keys) problems.push('SERVICE_TICKET_TASK_KEYS not found');
      else if (/assignee/.test(keys)) problems.push('86 can put a name on a building again');
      const refusedKeys = between(src, 'const SERVICE_TICKET_TASK_REFUSED_KEYS = {', '};');
      if (!refusedKeys || refusedKeys.indexOf('assignee_user_id: subtaskDoor.MSG.notAssignable') < 0) {
        problems.push('86 no longer refuses assignee_user_id on a punch-list add by name');
      }
      return problems;
    },
  },
  'server/services/client-merge.js': {
    why: 'A client merge repoints what was filed against the folded client. It moves tasks.entity_id and nothing else - not status, not service_ticket_id - so no work-order rule is reachable through it and there is nothing for the subtask door to decide.',
    assignment: 'never',
    check(src) {
      const problems = [];
      const hits = src.match(/UPDATE\s+tasks\b/gi) || [];
      if (hits.length !== 1) problems.push('expected exactly one tasks statement, found ' + hits.length);
      const at = src.search(/UPDATE\s+tasks\b/i);
      const stmt = at < 0 ? '' : src.slice(at, at + 300).split('"')[0];
      if (stmt.indexOf('SET entity_id = $1, updated_at = NOW()') < 0) problems.push('the merge no longer moves ONLY entity_id on tasks');
      if (stmt.indexOf("entity_type = 'client'") < 0) problems.push('the tasks move is no longer scoped to client rows');
      if (stmt.indexOf('organization_id') < 0) problems.push('the tasks move lost its organization predicate');
      if (/status|service_ticket_id|done|assignee/i.test(stmt)) problems.push('the merge now touches work-order fields on tasks');
      return problems;
    },
  },
  'server/services/org-reset.js': {
    why: 'Wipes a whole organization. Nothing survives to follow a rule.',
    // A DELETE puts nothing into a row.
    assignment: 'never',
    check(src) {
      return /DELETE FROM tasks WHERE organization_id = \$1/.test(src) ? [] : ['the org wipe lost its organization predicate'];
    },
  },
  'server/services/work-order-review.js': {
    why: 'The office Send back reopens the buildings it names, inside changeStatus under the ticket lock.',
    // Reopening writes status and completed_at. Who is responsible does not
    // change when a building is sent back — it never sat on the building.
    assignment: 'never',
    optional: true,
    check(src) {
      const problems = [];
      const re = /UPDATE\s+tasks\b/gi;
      let m;
      while ((m = re.exec(src))) {
        const stmt = src.slice(m.index, m.index + 400).split(/RETURNING|`\s*,/)[0];
        for (const need of ['organization_id', 'service_ticket_id', "status = 'done'"]) {
          if (stmt.indexOf(need) < 0) problems.push('the send-back UPDATE tasks lost ' + need);
        }
      }
      return problems;
    },
  },
};

// Pure: given files [{rel, src}] and a ledger, the census problems.
function census(files, ledger) {
  const L = ledger || LEDGER;
  const problems = [];
  const writers = new Set();
  for (const f of files) {
    if (!WRITES_TASKS.test(f.src)) continue;
    writers.add(f.rel);
    const entry = L[f.rel];
    if (!entry) { problems.push(f.rel + ': ' + UNLISTED); continue; }
    // THE 1.35 CLASS RULE, before anything the entry says about itself.
    if (entry.assignment === 'refused') {
      if (!REFUSES_ASSIGNMENT.test(norm(f.src))) problems.push(f.rel + ': ' + NOT_REFUSED);
    } else if (entry.assignment === 'never') {
      for (const cols of writtenColumns(f.src)) {
        if (/assignee/i.test(cols)) { problems.push(f.rel + ': ' + WRITES_OWNER); break; }
      }
    } else if (entry.assignment === 'unreachable') {
      // The claim is that no building is in the set this file can write, so the
      // entry owes a proof of that and not a sentence about it.
      if (typeof entry.provesUnreachable !== 'function') problems.push(f.rel + ': ' + NO_PROOF);
      else for (const q of entry.provesUnreachable(norm(f.src))) problems.push(f.rel + ': ' + q);
    } else {
      problems.push(f.rel + ': ' + UNCLASSIFIED);
    }
    for (const p of entry.check(norm(f.src))) problems.push(f.rel + ': ' + p);
  }
  for (const [file, entry] of Object.entries(L)) {
    if (!writers.has(file) && !entry.optional) problems.push(file + ': on the ledger but no longer writes tasks — take it off');
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

describe('the task-path ledger', () => {
  test('the walk really reaches the files that write tasks', () => {
    const writers = FILES.filter((f) => WRITES_TASKS.test(f.src)).map((f) => f.rel);
    expect(writers).toEqual(expect.arrayContaining([
      'server/routes/tasks-routes.js', 'server/routes/task-share-routes.js',
      'server/services/payload-dispatcher.js', 'server/services/service-ticket-workorder.js',
      'server/services/org-reset.js',
    ]));
    expect(FILES.length).toBeGreaterThan(100);
  });

  test('every file that writes tasks is on the ledger, and every entry holds', () => {
    expect(census(FILES)).toEqual([]);
  });

  test('every entry says why, and says whether a name can reach a building through it', () => {
    for (const [f, entry] of Object.entries(LEDGER)) {
      expect([f, entry.why.length > 20]).toEqual([f, true]);
      expect([f, entry.assignment]).toEqual([f, expect.stringMatching(/^(refused|never|unreachable)$/)]);
      // 'unreachable' is the only answer that owes a proof rather than a word.
      if (entry.assignment === 'unreachable') expect([f, typeof entry.provesUnreachable]).toEqual([f, 'function']);
    }
  });
});

describe('the ledger is not decoration', () => {
  test('a new file that writes tasks fails with the sentence that says what to do', () => {
    const files = FILES.concat([{ rel: 'server/routes/new-crew-door.js', src: "await pool.query('UPDATE tasks SET status = $1 WHERE id = $2', [s, id]);" }]);
    expect(census(files)).toEqual(['server/routes/new-crew-door.js: ' + UNLISTED]);
  });

  test('tasks PATCH without the door call fails', () => {
    const file = 'server/routes/tasks-routes.js';
    const src = mutate(sourceOf(file), '        const result = await workOrder.setSubtaskDone(client, {\n',
      '        const result = await Promise.resolve({ ok: true, ticket: newTicket }); ({\n');
    expect(census(withFile(file, src))).toEqual([file + ': PATCH no longer calls workOrder.setSubtaskDone']);
  });

  test('tasks POST without the structure verdict fails', () => {
    const file = 'server/routes/tasks-routes.js';
    const src = mutate(sourceOf(file),
      "        const verdict = await subtaskDoor.structureVerdict(client, { user: req.user, orgId, ticket });\n        if (!verdict.ok) return { refusal: verdict };\n        if (String(body.status) === 'done') {\n",
      "        if (String(body.status) === 'done') {\n");
    expect(census(withFile(file, src))).toEqual([file + ': POST no longer calls subtaskDoor.structureVerdict']);
  });

  test('tasks DELETE without the recount fails', () => {
    const file = 'server/routes/tasks-routes.js';
    const src = mutate(sourceOf(file), "        const moved = await workOrder.recountTicket(client, ticket, actor, 'subtask_removed');\n",
      '        const moved = { ticketStatus: ticket.status, movedTo: null };\n');
    expect(census(withFile(file, src))).toEqual([file + ': DELETE no longer calls workOrder.recountTicket']);
  });

  test('the task link without setSubtaskDone fails', () => {
    const file = 'server/routes/task-share-routes.js';
    const src = mutate(sourceOf(file), '          result = await workOrder.setSubtaskDone(client, {\n', '          result = await Promise.resolve({\n');
    expect(census(withFile(file, src))).toEqual([file + ': PATCH no longer calls workOrder.setSubtaskDone']);
  });

  test('the task link without the re-read under the lock fails', () => {
    const file = 'server/routes/task-share-routes.js';
    const src = mutate(sourceOf(file),
      '        if (subtaskDoor.taskShifted(req.task, fresh.rows[0])) return subtaskDoor.stale();\n', '');
    expect(census(withFile(file, src))).toEqual([file + ': PATCH no longer decides on the task row under the ticket lock']);
  });

  test('tasks PATCH without the re-read under the lock, or without the assign verdict, fails', () => {
    const file = 'server/routes/tasks-routes.js';
    const noReread = mutate(sourceOf(file),
      '      if (subtaskDoor.taskShifted(before, fresh.rows[0])) return { refusal: subtaskDoor.stale() };\n', '');
    expect(census(withFile(file, noReread))).toEqual([file + ': PATCH no longer calls subtaskDoor.taskShifted']);
    // 1.35 moved this refusal OUT of the transaction: assignVerdict always
    // says no now, so there is nothing left to decide under the lock.
    const noAssign = mutate(sourceOf(file),
      '    if (assignChange && endsUpABuilding) return sendRefusal(res, subtaskDoor.assignVerdict());\n', '');
    expect(census(withFile(file, noAssign))).toEqual([
      file + ': PATCH no longer calls subtaskDoor.assignVerdict',
      file + ': PATCH no longer refuses an assignee on a building',
    ]);
  });

  test('MUTANT: creating a building with an assignee stops being refused and the name sticks', () => {
    const file = 'server/routes/tasks-routes.js';
    const src = mutate(sourceOf(file),
      '      return sendRefusal(res, subtaskDoor.assignVerdict());\n', '');
    expect(census(withFile(file, src))).toEqual([
      file + ': POST no longer refuses an assignee on a building',
    ]);
  });

  test('MUTANT: the crew link goes back to dropping an assignee in silence', () => {
    const file = 'server/routes/task-share-routes.js';
    const src = mutate(sourceOf(file),
      "    if (Object.prototype.hasOwnProperty.call(body, 'assignee_user_id') &&\n" +
      '        subtaskDoor.isWorkOrderSubtask(req.task)) {\n' +
      '      const refusal = subtaskDoor.assignVerdict();\n' +
      '      return res.status(refusal.status).json({ error: refusal.error, code: refusal.code });\n' +
      '    }\n', '');
    expect(census(withFile(file, src))).toEqual([
      file + ': ' + NOT_REFUSED,
      file + ': PATCH no longer refuses an assignee on a building',
    ]);
  });

  test('MUTANT: 86 gets assignee_user_id back as a punch-list key', () => {
    const file = 'server/services/payload-dispatcher.js';
    const src = mutate(sourceOf(file),
      "const SERVICE_TICKET_TASK_KEYS = new Set(['title', 'notes', 'priority', 'due_date']);",
      "const SERVICE_TICKET_TASK_KEYS = new Set(['title', 'notes', 'priority', 'due_date', 'assignee_user_id']);");
    expect(census(withFile(file, src))).toEqual([
      file + ': 86 can put a name on a building again',
    ]);
  });

  test("MUTANT: Send back clears the building's assignee, and a writer classified 'never' writes one", () => {
    const file = 'server/services/work-order-review.js';
    const src = mutate(sourceOf(file),
      "UPDATE tasks SET status = 'open', completed_at = NULL, updated_at = NOW()",
      "UPDATE tasks SET status = 'open', completed_at = NULL, assignee_user_id = NULL, updated_at = NOW()");
    expect(census(withFile(file, src))).toEqual([file + ': ' + WRITES_OWNER]);
  });

  test('a writer that does not say whether a name can reach a building fails, with the sentence that says what to decide', () => {
    const target = 'server/services/org-reset.js';
    const unclassified = Object.assign({}, LEDGER);
    unclassified[target] = Object.assign({}, LEDGER[target], { assignment: undefined });
    expect(census(FILES, unclassified)).toEqual([target + ': ' + UNCLASSIFIED]);
    expect(census(FILES)).toEqual([]);
  });

  test('86 task_adds without the recount fails', () => {
    const file = 'server/services/payload-dispatcher.js';
    const src = mutate(sourceOf(file),
      "    await workOrder.recountTicket(dbClient, before, { kind: 'agent', userId }, 'subtask_added');\n", '');
    expect(census(withFile(file, src))).toEqual([file + ': recountTicket does not run after the task_adds INSERT']);
  });

  test('a send-back UPDATE tasks without its organization predicate fails, when the file has one', () => {
    const file = 'server/services/work-order-review.js';
    const src = 'await client.query(`UPDATE tasks SET status = \'open\' WHERE id = ANY($1::text[]) AND service_ticket_id = $2 AND status = \'done\' RETURNING id`, p);';
    const files = FILES.filter((f) => f.rel !== file).concat([{ rel: file, src }]);
    expect(census(files)).toEqual([file + ': the send-back UPDATE tasks lost organization_id']);
  });

  test('an entry for a file that stopped writing tasks fails, unless it is optional', () => {
    const files = FILES.filter((f) => f.rel !== 'server/services/org-reset.js' && f.rel !== 'server/services/work-order-review.js');
    expect(census(files)).toEqual(['server/services/org-reset.js: on the ledger but no longer writes tasks — take it off']);
  });
});
