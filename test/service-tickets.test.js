// Service tickets — the pure decision layer.
//
// This suite deliberately needs NO database and NO JWT_SECRET, which is why
// server/services/service-tickets.js requires nothing. Tests that reach
// server/routes/* only pass where JWT_SECRET is set, so the rules that decide
// what an anonymous stranger may see and change live here, where they always
// run.
//
// The load-bearing assertion in the whole feature is that there is no 'edit'
// scope and that an unknown scope NARROWS. Everything else is downstream of it.

const assert = require('assert');
const st = require('../server/services/service-tickets');


// ── Purity ──────────────────────────────────────────────────────────────
test('the module is pure — no pool, no express, no env', () => {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'server', 'services', 'service-tickets.js'), 'utf8');
  for (const banned of ['require(\'pg\')', 'require("pg")', 'require(\'express\')',
                        'process.env', '../db', './db']) {
    assert.ok(src.indexOf(banned) === -1,
      'must not reference ' + banned + ' — this suite runs with no DB and no JWT_SECRET');
  }
});

// ── Scope: the single most important line in the feature ────────────────
test("normalizeScope('edit') is 'view' — there is no edit scope", () => {
  assert.strictEqual(st.normalizeScope('edit'), 'view');
});

test('every unknown scope narrows to view, never widens', () => {
  // NB 'propose ' is NOT here: normalizeScope trims, matching report-shares.js,
  // so a stray space is a valid scope and the next test pins that.
  for (const bad of ['admin', 'owner', 'write', 'editor', 'read-write', null, undefined,
                     '', 0, 1, {}, [], 'view;--', 'respond,propose', 'propose;drop']) {
    assert.strictEqual(st.normalizeScope(bad), 'view', 'scope ' + JSON.stringify(bad));
  }
});

test('the three real scopes survive normalization, case/space insensitively', () => {
  assert.strictEqual(st.normalizeScope('view'), 'view');
  assert.strictEqual(st.normalizeScope(' RESPOND '), 'respond');
  assert.strictEqual(st.normalizeScope('Propose'), 'propose');
  assert.deepStrictEqual(st.SHARE_SCOPES.slice(), ['view', 'respond', 'propose']);
});

test('scopeAllows is a rank ladder, and view can do nothing but read', () => {
  assert.strictEqual(st.scopeAllows('view', 'view'), true);
  assert.strictEqual(st.scopeAllows('view', 'respond'), false);
  assert.strictEqual(st.scopeAllows('view', 'propose'), false);
  assert.strictEqual(st.scopeAllows('respond', 'respond'), true);
  assert.strictEqual(st.scopeAllows('respond', 'propose'), false);
  assert.strictEqual(st.scopeAllows('propose', 'respond'), true);
  // An unknown scope grants nothing beyond view.
  assert.strictEqual(st.scopeAllows('edit', 'respond'), false);
});

// ── Financials ──────────────────────────────────────────────────────────
test('financials hide unless the row EXPLICITLY says false', () => {
  assert.strictEqual(st.hidesFinancials({ hide_financials: false }), false);
  for (const v of [true, undefined, null, 0, 1, 'false', 'no', '']) {
    assert.strictEqual(st.hidesFinancials({ hide_financials: v }), true, 'value ' + JSON.stringify(v));
  }
  assert.strictEqual(st.hidesFinancials(null), true);
  assert.strictEqual(st.hidesFinancials({}), true);
});

// ── Token ───────────────────────────────────────────────────────────────
test('tokens are 256 bits of hex and hashed at rest', () => {
  const t = st.genToken();
  assert.ok(/^[a-f0-9]{64}$/.test(t), 'token is 64 hex chars');
  const h = st.hashToken(t);
  assert.ok(/^[a-f0-9]{64}$/.test(h));
  assert.notStrictEqual(h, t, 'the hash must not equal the token');
  assert.strictEqual(st.hashToken(t), h, 'hashing is deterministic');
  assert.notStrictEqual(st.genToken(), st.genToken());
});

test('a malformed token is rejected before it reaches the database', () => {
  assert.strictEqual(st.isWellFormedToken(st.genToken()), true);
  for (const bad of ['', null, undefined, 'abc', 'A'.repeat(64), 'g'.repeat(64),
                     '0'.repeat(63), '0'.repeat(65), "' OR 1=1--"]) {
    assert.strictEqual(st.isWellFormedToken(bad), false, JSON.stringify(bad));
  }
});

// ── TTL ─────────────────────────────────────────────────────────────────
test('ttl clamps to 1..90 days and defaults to 30', () => {
  assert.strictEqual(st.clampTtlDays(undefined), 30);
  assert.strictEqual(st.clampTtlDays('nonsense'), 30);
  assert.strictEqual(st.clampTtlDays(0), 1);
  assert.strictEqual(st.clampTtlDays(-99), 1);
  assert.strictEqual(st.clampTtlDays(9999), 90);
  assert.strictEqual(st.clampTtlDays(7.9), 7);
});

// ── Lifecycle: the guest lattice is a STRICT subset ─────────────────────
test('a guest can never MOVE a ticket to approved, closed or cancelled', () => {
  for (const from of st.TICKET_STATUSES) {
    for (const to of ['approved', 'closed', 'cancelled']) {
      // from === to is a no-op, not a transition: PATCHing status to the value
      // it already holds must not 403, or every guest write that echoes the
      // current status would be refused.
      if (from === to) continue;
      const r = st.ticketMayTransition(from, to, 'share');
      assert.strictEqual(r.ok, false, from + ' -> ' + to + ' must be refused for a share');
      assert.ok(r.reason, 'a refusal must say why');
    }
  }
});

test('a guest can never move a ticket backwards, or back into draft/open', () => {
  for (const from of st.TICKET_STATUSES) {
    for (const to of ['draft', 'open', 'scheduled']) {
      if (from === to) continue;
      assert.strictEqual(st.ticketMayTransition(from, to, 'share').ok, false,
        from + ' -> ' + to + ' must be refused for a share');
    }
  }
});

test('a guest CAN do the two things a crew actually does', () => {
  assert.strictEqual(st.ticketMayTransition('open', 'in_progress', 'share').ok, true);
  assert.strictEqual(st.ticketMayTransition('scheduled', 'in_progress', 'share').ok, true);
  assert.strictEqual(st.ticketMayTransition('in_progress', 'work_complete', 'share').ok, true);
  assert.strictEqual(st.ticketMayTransition('open', 'work_complete', 'share').ok, true);
});

test('a draft is not reachable or leavable by a guest at all', () => {
  for (const to of st.TICKET_STATUSES) {
    if (to === 'draft') continue;
    assert.strictEqual(st.ticketMayTransition('draft', to, 'share').ok, false);
  }
});

test('terminal states are terminal for a guest — every door is shut', () => {
  for (const from of ['closed', 'cancelled']) {
    for (const to of st.TICKET_STATUSES) {
      if (from === to) continue;
      assert.strictEqual(st.ticketMayTransition(from, to, 'share').ok, false,
        from + ' -> ' + to);
    }
  }
});

test('an unknown actor is treated as a guest, never as a PM', () => {
  // Fail closed: a caller that forgets to pass the actor must not get the
  // privileged lattice.
  for (const actor of [undefined, null, '', 'admin', 'system', 'User']) {
    assert.strictEqual(st.ticketMayTransition('work_complete', 'approved', actor).ok, false,
      'actor ' + JSON.stringify(actor) + ' must not get the user lattice');
  }
  assert.strictEqual(st.ticketMayTransition('work_complete', 'approved', 'user').ok, true);
});

test('a PM can move the ticket through the office lattice, including reopening', () => {
  assert.strictEqual(st.ticketMayTransition('draft', 'open', 'user').ok, true);
  assert.strictEqual(st.ticketMayTransition('work_complete', 'approved', 'user').ok, true);
  assert.strictEqual(st.ticketMayTransition('approved', 'closed', 'user').ok, true);
  assert.strictEqual(st.ticketMayTransition('closed', 'open', 'user').ok, true);
  // But not arbitrary jumps.
  assert.strictEqual(st.ticketMayTransition('draft', 'closed', 'user').ok, false);
  assert.strictEqual(st.ticketMayTransition('draft', 'approved', 'user').ok, false);
});

test('an unknown target status is refused for everyone', () => {
  for (const actor of ['user', 'share']) {
    assert.strictEqual(st.ticketMayTransition('open', 'deleted', actor).ok, false);
    assert.strictEqual(st.ticketMayTransition('open', '', actor).ok, false);
    assert.strictEqual(st.ticketMayTransition('open', null, actor).ok, false);
  }
});

test('a draft cannot be shared, and neither can a terminal ticket', () => {
  assert.strictEqual(st.ticketMayBeShared({ status: 'draft' }).ok, false);
  assert.strictEqual(st.ticketMayBeShared({ status: 'closed' }).ok, false);
  assert.strictEqual(st.ticketMayBeShared({ status: 'cancelled' }).ok, false);
  assert.strictEqual(st.ticketMayBeShared({ status: 'open' }).ok, true);
  assert.strictEqual(st.ticketMayBeShared({ status: 'in_progress' }).ok, true);
  // An unknown status normalizes to draft, so it is refused — fail closed.
  assert.strictEqual(st.ticketMayBeShared({ status: 'whatever' }).ok, false);
});

// ── Share lifecycle ─────────────────────────────────────────────────────
test('revoked beats expired beats opened beats sent', () => {
  const future = new Date(Date.now() + 86400000).toISOString();
  const past = new Date(Date.now() - 86400000).toISOString();
  assert.strictEqual(st.shareLifecycle({ expires_at: future }), 'sent');
  assert.strictEqual(st.shareLifecycle({ expires_at: future, opened_at: past }), 'opened');
  assert.strictEqual(st.shareLifecycle({ expires_at: past, opened_at: past }), 'expired');
  assert.strictEqual(st.shareLifecycle({ expires_at: past, revoked_at: past }), 'revoked');
  assert.strictEqual(st.shareLifecycle({ expires_at: future, revoked_at: past }), 'revoked');
});

test('only sent and opened shares are usable', () => {
  const future = new Date(Date.now() + 86400000).toISOString();
  const past = new Date(Date.now() - 86400000).toISOString();
  assert.strictEqual(st.shareIsUsable({ expires_at: future }), true);
  assert.strictEqual(st.shareIsUsable({ expires_at: future, opened_at: past }), true);
  assert.strictEqual(st.shareIsUsable({ expires_at: past }), false);
  assert.strictEqual(st.shareIsUsable({ expires_at: future, revoked_at: past }), false);
  assert.strictEqual(st.shareIsUsable(null), false);
});

// ── Public projections are WHITELISTS ───────────────────────────────────
test('publicTicket cannot leak a column added to the table later', () => {
  const row = {
    id: 't1', title: 'Fix the gate', status: 'open',
    // Everything below must NOT appear.
    organization_id: 7, job_id: 'j1', lead_id: 'l1', internal_notes: 'client is difficult',
    assignee_user_id: 4, created_by: 4, archived_at: null,
    some_column_added_next_year: 'SECRET',
    contract_value: 125000,
  };
  const pub = st.publicTicket(row, { hide_financials: true });
  assert.strictEqual(pub.title, 'Fix the gate');
  for (const leaked of ['organization_id', 'job_id', 'lead_id', 'internal_notes',
                        'assignee_user_id', 'created_by',
                        'some_column_added_next_year', 'contract_value']) {
    assert.strictEqual(pub[leaked], undefined, leaked + ' must not reach a guest');
  }
});

test('scope_approved is the one field gated on hide_financials', () => {
  const row = { id: 't1', title: 'x', status: 'open', scope_approved: 'signed scope' };
  assert.strictEqual(st.publicTicket(row, { hide_financials: true }).scope_approved, undefined);
  assert.strictEqual(st.publicTicket(row, {}).scope_approved, undefined);
  assert.strictEqual(st.publicTicket(row, null).scope_approved, undefined);
  assert.strictEqual(st.publicTicket(row, { hide_financials: false }).scope_approved, 'signed scope');
});

test('publicShare never returns the token, the hash, or the org', () => {
  const pub = st.publicShare({
    id: 's1', scope: 'respond', recipient_name: 'Ana', expires_at: 'x',
    token_hash: 'DEADBEEF', organization_id: 7, created_by: 4, recipient_email: 'a@b.c',
  });
  assert.deepStrictEqual(Object.keys(pub).sort(),
    ['expires_at', 'id', 'recipient_name', 'scope']);
  assert.strictEqual(pub.token_hash, undefined);
  assert.strictEqual(pub.organization_id, undefined);
  assert.strictEqual(pub.recipient_email, undefined);
});

test('publicShare normalizes a stored scope it does not recognise', () => {
  assert.strictEqual(st.publicShare({ id: 's', scope: 'edit' }).scope, 'view');
});

// ── The checklist gap that is NOT carried forward ───────────────────────
test('a guest may flip done, and nothing else', () => {
  const stored = [{ text: 'Pull permit', done: false }, { text: 'Set forms', done: false }];
  const out = st.normalizeGuestChecklist(stored, [
    { text: 'Pull permit', done: true },
    { text: 'Set forms', done: false },
  ]);
  assert.deepStrictEqual(out, [
    { text: 'Pull permit', done: true },
    { text: 'Set forms', done: false },
  ]);
});

test('a guest CANNOT wipe the checklist with an empty array', () => {
  // task-share-routes lets [] through: it is truthy at the `if (cl)` gate and
  // replaces the whole array. That is the defect this function exists to fix.
  const stored = [{ text: 'Pull permit', done: false }];
  assert.deepStrictEqual(st.normalizeGuestChecklist(stored, []), stored);
});

test('a guest CANNOT add, delete, rename or reorder items', () => {
  const stored = [{ text: 'Pull permit', done: false }, { text: 'Set forms', done: false }];
  // Add
  assert.strictEqual(st.normalizeGuestChecklist(stored,
    [{ text: 'Pull permit', done: true }, { text: 'Set forms', done: false },
     { text: 'Bill extra $5k', done: true }]).length, 2);
  // Rename — the text no longer matches, so the tick is refused too
  assert.deepStrictEqual(
    st.normalizeGuestChecklist(stored, [{ text: 'Pull permit (VOID)', done: true }]),
    stored);
  // Delete
  assert.strictEqual(st.normalizeGuestChecklist(stored, [{ text: 'Pull permit', done: true }]).length, 2);
  // Reorder — index and text must BOTH line up, so a swap flips nothing
  assert.deepStrictEqual(
    st.normalizeGuestChecklist(stored,
      [{ text: 'Set forms', done: true }, { text: 'Pull permit', done: true }]),
    stored);
});

test('a non-array from a guest leaves the stored list untouched', () => {
  const stored = [{ text: 'Pull permit', done: false }];
  for (const bad of [null, undefined, 'done', 42, {}]) {
    assert.deepStrictEqual(st.normalizeGuestChecklist(stored, bad), stored);
  }
});

test("the office's own checklist is bounded and cleaned", () => {
  const big = Array.from({ length: 80 }, (_, i) => ({ text: 'item ' + i }));
  assert.strictEqual(st.normalizeChecklist(big).length, 50);
  assert.deepStrictEqual(st.normalizeChecklist([{ text: '  trim me  ', done: 1 }]),
    [{ text: 'trim me', done: true }]);
  assert.deepStrictEqual(st.normalizeChecklist([{ text: '   ' }, null, 5]), [{ text: '5', done: false }]);
  assert.deepStrictEqual(st.normalizeChecklist('nope'), []);
  assert.strictEqual(st.normalizeChecklist([{ text: 'x'.repeat(900) }])[0].text.length, 500);
});

// ── Guest note is append-only and always attributed ─────────────────────
test('a guest note is stamped with a name and never anonymous', () => {
  assert.ok(st.guestNoteStamp('Gate is welded shut', { recipient_name: 'Ana Ruiz' })
    .indexOf('Ana Ruiz') > -1);
  assert.ok(st.guestNoteStamp('x', { recipient_email: 'ana@sub.com' }).indexOf('ana@sub.com') > -1);
  assert.ok(st.guestNoteStamp('x', {}).indexOf('shared link') > -1);
  assert.ok(st.guestNoteStamp('x', null).indexOf('shared link') > -1);
});

test('an empty note produces nothing to append, not an empty stamp', () => {
  assert.strictEqual(st.guestNoteStamp('', {}), null);
  assert.strictEqual(st.guestNoteStamp('   ', {}), null);
  assert.strictEqual(st.guestNoteStamp(null, {}), null);
});

test('a guest note is capped', () => {
  const s = st.guestNoteStamp('y'.repeat(9000), { recipient_name: 'A' });
  assert.ok(s.length < 2200, 'stamp length ' + s.length);
});

test('a guest name is write-once — it cannot retroactively re-attribute', () => {
  assert.strictEqual(st.guestNameUpdate('Ana', 'Someone Else'), null);
  assert.strictEqual(st.guestNameUpdate('', 'Ana'), 'Ana');
  assert.strictEqual(st.guestNameUpdate(null, '  Ana  '), 'Ana');
  assert.strictEqual(st.guestNameUpdate(null, '   '), null);
  assert.strictEqual(st.guestNameUpdate(null, 'x'.repeat(500)).length, 120);
});

// ── Proposals ───────────────────────────────────────────────────────────
test('a proposal cannot carry status, assignment, approval or tenancy', () => {
  const out = st.filterProposedFields({
    scope_proposed: 'new scope',
    status: 'approved',
    assignee_user_id: 9,
    scope_approved: 'sneaky',
    internal_notes: 'sneaky',
    ticket_number: 'RV2006-ST9',
    organization_id: 1,
    job_id: 'j2',
    lead_id: 'l2',
    created_by: 1,
  });
  assert.deepStrictEqual(Object.keys(out), ['scope_proposed']);
});

test('a proposal of only dropped keys is EMPTY, so the route can 400 it', () => {
  // An empty proposal that answers ok leaves the sender believing they were
  // heard. The route must be able to tell the difference.
  const out = st.filterProposedFields({ status: 'closed', organization_id: 2 });
  assert.deepStrictEqual(out, {});
  assert.strictEqual(Object.keys(out).length, 0);
});

test('the PM may accept a SUBSET at apply time', () => {
  const proposed = { scope_proposed: 'new scope', due_date: '2026-10-01', title: 'New title' };
  const accepted = st.filterProposedFields(proposed, ['scope_proposed']);
  assert.deepStrictEqual(accepted, { scope_proposed: 'new scope' });
});

test('the accept-time narrowing cannot WIDEN past the proposable set', () => {
  // Re-filtering at apply time must never trust a stored field list.
  const accepted = st.filterProposedFields(
    { scope_proposed: 'x', status: 'closed' },
    ['scope_proposed', 'status', 'organization_id']);
  assert.deepStrictEqual(accepted, { scope_proposed: 'x' });
});

test('PROPOSABLE_FIELDS names nothing that decides money, identity or tenancy', () => {
  for (const banned of ['status', 'assignee_user_id', 'scope_approved', 'internal_notes',
                        'ticket_number', 'organization_id', 'job_id', 'lead_id',
                        'created_by', 'archived_at']) {
    assert.strictEqual(st.PROPOSABLE_FIELDS.indexOf(banned), -1, banned + ' must not be proposable');
  }
});

// ── Progress ────────────────────────────────────────────────────────────
test('progress counts live child tasks, not the status', () => {
  const p = st.ticketProgress({ status: 'in_progress' }, [
    { status: 'done' }, { status: 'open' }, { completed_at: '2026-01-01' },
    { status: 'done', archived_at: '2026-01-01' },   // archived: excluded entirely
  ]);
  assert.strictEqual(p.tasksTotal, 3);
  assert.strictEqual(p.tasksDone, 2);
  assert.strictEqual(p.status, 'in_progress');
  assert.strictEqual(p.terminal, false);
});

test('progress is defined for a ticket with no tasks at all', () => {
  const p = st.ticketProgress({ status: 'draft' }, null);
  assert.strictEqual(p.tasksTotal, 0);
  assert.strictEqual(p.tasksDone, 0);
  assert.strictEqual(p.step, 0);
});

test('a closed ticket reports terminal', () => {
  assert.strictEqual(st.ticketProgress({ status: 'closed' }, []).terminal, true);
  assert.strictEqual(st.ticketProgress({ status: 'cancelled' }, []).terminal, true);
});

// ── Ids ─────────────────────────────────────────────────────────────────
test('ids are prefixed, unique and contain no path separator', () => {
  const a = st.genId('st');
  const b = st.genId('st');
  assert.notStrictEqual(a, b);
  assert.ok(a.indexOf('st_') === 0);
  assert.strictEqual(a.indexOf('/'), -1, 'an id must never be able to inject a path segment');
});


// ── The tier-above-tasks invariant ──────────────────────────────────────
// THE assertion for S2, and the reason tasks got their own service_ticket_id
// column instead of reusing entity_type='service_ticket'.
//
// tasks has no job_id and no lead_id — its ONLY parent pointer is the
// (entity_type, entity_id) pair. If a ticket claimed that slot, a task under a
// ticket on a job would silently vanish from four shipped surfaces: the job
// overview Tasks panel, the My Tasks "Job" column,
// read_entity(job, include:['tasks']) and the idx_tasks_entity index path.
//
// These are source-level assertions rather than DB ones because this suite
// runs with no database — but they pin the exact shapes that would break.
describe('a task under a ticket still belongs to its job', () => {
  const fs = require('fs');
  const path = require('path');
  const routes = fs.readFileSync(
    path.join(__dirname, '..', 'server', 'routes', 'tasks-routes.js'), 'utf8');
  const ui = fs.readFileSync(
    path.join(__dirname, '..', 'js', 'service-tickets.js'), 'utf8');

  test("service_ticket_id is a SEPARATE column, never an entity_type value", () => {
    // If this string ever appears, the polymorphic slot has been claimed and
    // the four surfaces above are broken.
    assert.strictEqual(routes.indexOf("'service_ticket'"), -1,
      "tasks must never use entity_type='service_ticket' — it consumes the " +
      "task's only parent pointer");
    assert.ok(routes.indexOf("'service_ticket_id'") > -1,
      'the separate column must be in EDITABLE_FIELDS');
  });

  test('the UI stamps the ticket AND the parent entity when adding a task', () => {
    // Sending only service_ticket_id would create a task that belongs to a
    // work order and to no job — the exact disappearance this design avoids.
    const add = ui.slice(ui.indexOf('function addTask()'), ui.indexOf('if (addGo) addGo.addEventListener'));
    assert.ok(add.indexOf('service_ticket_id') > -1, 'must stamp the ticket');
    assert.ok(add.indexOf('entity_type') > -1, 'must ALSO stamp entity_type');
    assert.ok(add.indexOf('entity_id') > -1, 'must ALSO stamp entity_id');
    assert.ok(/entity_type:\s*t\.job_id\s*\?\s*'job'\s*:\s*'lead'/.test(add),
      'the entity type must follow the ticket\'s own parent');
  });

  test('a caller-supplied ticket id is PROVED in-org before it is written', () => {
    // The FK only proves the ticket EXISTS, never whose it is. Without this a
    // caller could file their task under another tenant's work order.
    assert.ok(routes.indexOf('async function serviceTicketOk') > -1,
      'a validator must exist');
    assert.ok(/SELECT 1 FROM service_tickets WHERE id = \$1 AND organization_id = \$2/.test(routes),
      'the validator must carry the org predicate');
    // Both write doors — create and patch — must use it.
    const createGuard = routes.indexOf('body.service_ticket_id && !(await serviceTicketOk');
    const patchGuard = routes.indexOf('if (!(await serviceTicketOk(orgId, val)))');
    assert.ok(createGuard > -1, 'POST /api/tasks must prove the ticket');
    assert.ok(patchGuard > -1, 'PATCH /api/tasks/:id must prove the ticket');
  });

  test('the ticket filter does not replace the entity filter', () => {
    // Both clauses must be independently applicable, so "this job's tasks" and
    // "this ticket's tasks" are different questions with different answers.
    assert.ok(/req\.query\.service_ticket_id/.test(routes));
    assert.ok(/req\.query\.entity_type/.test(routes));
    const stIdx = routes.indexOf('req.query.service_ticket_id');
    const entIdx = routes.indexOf('req.query.entity_type');
    assert.notStrictEqual(stIdx, entIdx);
    // Neither may be inside an else-branch of the other.
    const between = routes.slice(Math.min(stIdx, entIdx), Math.max(stIdx, entIdx));
    assert.strictEqual(between.indexOf('} else if (req.query'), -1,
      'the two filters must be independent, not alternatives');
  });
});

// ── S3: the lead→job carry-forward ──────────────────────────────────────
// A ticket raised during the pursuit must KEEP its lead and GAIN its job. That
// is the entire justification for two nullable parent columns instead of the
// polymorphic (entity_type, entity_id) pair — /api/jobs/convert re-points
// exactly one child table (receipts) and strands the rest on the lead forever.
// These are source-level assertions because this suite has no database.
describe('a ticket survives its lead becoming a job', () => {
  const fs = require('fs');
  const path = require('path');
  const jobRoutes = fs.readFileSync(
    path.join(__dirname, '..', 'server', 'routes', 'job-routes.js'), 'utf8');
  const leadRoutes = fs.readFileSync(
    path.join(__dirname, '..', 'server', 'routes', 'lead-routes.js'), 'utf8');

  // Both convert paths — /convert (INSERTs a job) and /:id/link-estimate
  // ("mirrors /convert but UPDATEs instead of INSERTing"). Missing the second
  // is the classic half-fix here.
  const carry = jobRoutes.match(/UPDATE service_tickets SET job_id = \$1/g) || [];

  test('BOTH convert paths carry tickets forward, not just /convert', () => {
    assert.strictEqual(carry.length, 2,
      'expected the carry-forward in /convert AND in /:id/link-estimate');
  });

  test('it STAMPS job_id and never clears lead_id', () => {
    // The whole point. `SET job_id = ..., lead_id = NULL` would reproduce the
    // receipts behaviour and lose the provenance.
    assert.strictEqual(jobRoutes.indexOf('SET job_id = $1, lead_id = NULL'), -1,
      'lead_id must be KEPT — a converted ticket is still about that lead');
    assert.ok(/UPDATE service_tickets SET job_id = \$1, updated_at = NOW\(\)/.test(jobRoutes));
  });

  test('it cannot steal a ticket that already belongs to another job', () => {
    const stmts = jobRoutes.split('UPDATE service_tickets SET job_id = $1').slice(1);
    assert.strictEqual(stmts.length, 2);
    for (const s of stmts) {
      const clause = s.slice(0, 200);
      assert.ok(clause.indexOf('job_id IS NULL') > -1,
        'the WHERE must be guarded on job_id IS NULL (idempotent, non-stealing)');
      assert.ok(clause.indexOf('organization_id = $3') > -1,
        'the WHERE must carry the org predicate');
      assert.ok(clause.indexOf('lead_id = $2') > -1,
        'it must select by the lead being converted');
    }
  });

  // Deleting a lead SET NULLs service_tickets.lead_id. For a converted ticket
  // that is fine (job_id holds the CHECK up). For one that never converted,
  // both parents go NULL, service_tickets_parent_chk fires, and an unguarded
  // route turns that into a blank 500.
  test('both lead-delete paths refuse readably instead of 500ing', () => {
    assert.ok(leadRoutes.indexOf('async function leadsBlockedByTickets') > -1,
      'a shared guard must exist');
    // Used by the single delete AND the bulk delete.
    const uses = (leadRoutes.match(/leadsBlockedByTickets\(/g) || []).length;
    assert.ok(uses >= 3, 'expected the definition plus both call sites, got ' + uses);
    assert.ok(leadRoutes.indexOf('res.status(409)') > -1, 'must answer 409, not 500');
  });

  test('the guard only blocks on UNCONVERTED, unarchived tickets', () => {
    const fn = leadRoutes.slice(
      leadRoutes.indexOf('async function leadsBlockedByTickets'),
      leadRoutes.indexOf('// POST /api/leads/bulk-delete'));
    assert.ok(fn.indexOf('job_id IS NULL') > -1,
      'a ticket that already carries a job survives the delete — do not block on it');
    assert.ok(fn.indexOf('archived_at IS NULL') > -1,
      'an archived ticket must not block a lead delete');
    assert.ok(fn.indexOf('organization_id = $2') > -1,
      'the org predicate goes on the TICKET, not inferred from the lead');
  });
});
