// Review & approve (1.29): the rules every office status move runs through.
//
// server/services/work-order-review.js holds them PURE (reasonRule,
// normalizeReason, statusStamps, normalizeReopenList, sendBackFromEvent), so
// most of this suite needs no database. The two readers (activeSendBack,
// peopleNames) are then driven over node:sqlite through the pg shim with a
// second org in the fixture, and the send-back banner rule is removed from a
// temp copy of the module to show the banner would outlive a re-completion.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const svc = require('../server/services/service-tickets');
const R = require('../server/services/work-order-review');
const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema } = require('./helpers/db-schema');

const SRC = path.join(__dirname, '..', 'server', 'services', 'work-order-review.js');
const SVC_ABS = path.join(__dirname, '..', 'server', 'services', 'service-tickets.js').split(path.sep).join('/');
const made = [];

function mutant(find, replace) {
  const src = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');
  if (src.split(find).length !== 2) throw new Error('anchor not found');
  const out = src.replace(find, replace)
    .replace("require('./service-tickets')", 'require(' + JSON.stringify(SVC_ABS) + ')');
  const p = path.join(os.tmpdir(), '_p86_wor_' + process.pid + '_' + Math.random().toString(36).slice(2, 9) + '.js');
  fs.writeFileSync(p, out, 'utf8');
  made.push(p);
  return require(p);
}

let eng;
beforeAll(() => {
  eng = createPgSqlite(sqliteSchema(['organizations', 'users', 'service_ticket_events']), { jsonColumns: ['detail'] });
});
afterAll(() => {
  if (eng) eng.close();
  for (const p of made) { try { fs.unlinkSync(p); } catch (_) {} }
});

// Every move the office lattice allows.
const MOVES = [];
for (const from of Object.keys({
  draft: 1, open: 1, scheduled: 1, in_progress: 1, work_complete: 1, approved: 1, closed: 1, cancelled: 1,
})) {
  for (const to of svc.TICKET_STATUSES) {
    if (from !== to && svc.ticketMayTransition(from, to, 'user').ok) MOVES.push([from, to]);
  }
}

describe('constants', () => {
  test('caps and the stale sentence', () => {
    expect([R.REASON_MAX, R.BUILDING_NOTE_MAX, R.REOPEN_MAX]).toEqual([1000, 500, 200]);
    expect(R.STALE_ERROR).toBe('This work order just changed. Reload to see the latest.');
  });
});

describe('reasonRule over every move the office may make', () => {
  test('the lattice has the moves this suite expects', () => {
    expect(MOVES.length).toBe(20);
  });

  test('a reason is required exactly for cancel, send back, reopen and unapprove', () => {
    const MSG = {
      send_back: 'Say what needs fixing. The crew sees this on their link.',
      cancel: 'Say why this work order is being cancelled.',
      reopen: 'Say why this work order is being reopened.',
      unapprove: 'Say why the approval is being taken back.',
    };
    const seen = {};
    for (const [from, to] of MOVES) {
      const r = R.reasonRule(from, to);
      let want;
      if (to === 'approved') want = { action: 'approve', required: false, message: null };
      else if (from === 'approved' && to === 'work_complete') want = { action: 'unapprove', required: true, message: MSG.unapprove };
      else if (from === 'work_complete' && to === 'in_progress') want = { action: 'send_back', required: true, message: MSG.send_back };
      else if (to === 'cancelled') want = { action: 'cancel', required: true, message: MSG.cancel };
      else if ((from === 'closed' || from === 'cancelled') && to === 'open') want = { action: 'reopen', required: true, message: MSG.reopen };
      else want = { action: null, required: false, message: null };
      expect([from, to, r]).toEqual([from, to, want]);
      seen[r.action] = (seen[r.action] || 0) + 1;
    }
    // cancel from each of the six non-terminal statuses; reopen from closed and from cancelled.
    expect(seen).toEqual({ cancel: 6, reopen: 2, send_back: 1, unapprove: 1, approve: 1, null: 9 });
  });

  test('ordinary moves carry no action and need no reason', () => {
    for (const [from, to] of [['draft', 'open'], ['open', 'draft'], ['in_progress', 'work_complete'],
      ['in_progress', 'scheduled'], ['approved', 'closed']]) {
      expect(R.reasonRule(from, to)).toEqual({ action: null, required: false, message: null });
    }
    expect(R.reasonRule('cancelled', 'cancelled').action).toBeNull();
  });
});

describe('normalizeReason', () => {
  test('control characters become spaces, newlines stay, 3+ newlines collapse to 2', () => {
    expect(R.normalizeReason('Rail\u0000post\tloose\u0007', 1000)).toBe('Rail post loose');
    expect(R.normalizeReason('line one\r\nline two', 1000)).toBe('line one\nline two');
    expect(R.normalizeReason('a\n\n\n\n\nb', 1000)).toBe('a\n\nb');
    expect(R.normalizeReason('a\n\nb', 1000)).toBe('a\n\nb');
    expect(R.normalizeReason('x\u009By', 1000)).toBe('x y');
  });

  test("whitespace, null and undefined are ''", () => {
    expect(R.normalizeReason('  \n\t ', 1000)).toBe('');
    expect(R.normalizeReason(null, 1000)).toBe('');
    expect(R.normalizeReason(undefined)).toBe('');
    expect(R.normalizeReason(42, 1000)).toBe('42');
  });

  test('the cap counts code points, so an emoji is never cut in half', () => {
    const s = 'ab' + '\u{1F6A7}'.repeat(5);
    const out = R.normalizeReason(s, 3);
    expect(out).toBe('ab\u{1F6A7}');
    expect(Array.from(out).length).toBe(3);
    expect(/[\uD800-\uDBFF]$/.test(out)).toBe(false);
    expect(Array.from(R.normalizeReason('y'.repeat(5000))).length).toBe(1000);
  });
});

describe('statusStamps', () => {
  const WHO = (col) => col + ' = (SELECT u.id FROM users u WHERE u.id = $4 AND u.organization_id = $3)';

  test('approve stamps who and when through the in-org subquery', () => {
    expect(R.statusStamps('work_complete', 'approved', '$4', '$3')).toEqual(['approved_at = NOW()', WHO('approved_by')]);
  });

  test('taking back an approval clears it; arriving at work_complete keeps the first completion time', () => {
    expect(R.statusStamps('approved', 'work_complete', '$4', '$3'))
      .toEqual(['completed_at = COALESCE(completed_at, NOW())', 'approved_at = NULL', 'approved_by = NULL']);
    expect(R.statusStamps('in_progress', 'work_complete', '$4', '$3'))
      .toEqual(['completed_at = COALESCE(completed_at, NOW())']);
  });

  test('cancel stamps cancelled_*; approved stamps survive a cancel and a close', () => {
    expect(R.statusStamps('open', 'cancelled', '$4', '$3')).toEqual(['cancelled_at = NOW()', WHO('cancelled_by')]);
    expect(R.statusStamps('approved', 'cancelled', '$4', '$3').join(' ')).not.toMatch(/approved_/);
    expect(R.statusStamps('approved', 'closed', '$4', '$3')).toEqual(['closed_at = NOW()']);
  });

  test('reopening a cancelled or closed ticket clears all four decision stamps', () => {
    const CLEARED = ['completed_at = NULL', 'approval_notified_at = NULL', 'closed_at = NULL',
      'approved_at = NULL', 'approved_by = NULL', 'cancelled_at = NULL', 'cancelled_by = NULL'];
    expect(R.statusStamps('cancelled', 'open', '$4', '$3')).toEqual(CLEARED);
    expect(R.statusStamps('closed', 'open', '$4', '$3')).toEqual(CLEARED);
    // scheduled -> open is not a reopen: it clears nothing the office decided.
    expect(R.statusStamps('scheduled', 'open', '$4', '$3'))
      .toEqual(['completed_at = NULL', 'approval_notified_at = NULL', 'closed_at = NULL']);
  });

  test('a send back still clears completed_at and approval_notified_at', () => {
    expect(R.statusStamps('work_complete', 'in_progress', '$4', '$3'))
      .toEqual(['completed_at = NULL', 'approval_notified_at = NULL']);
    expect(R.statusStamps('in_progress', 'scheduled', '$4', '$3'))
      .toEqual(['completed_at = NULL', 'approval_notified_at = NULL']);
  });

  test('only approve and cancel reference the actor, so the caller binds it only then', () => {
    for (const [from, to] of MOVES) {
      const uses = R.statusStamps(from, to, '$4', '$3').some((f) => f.indexOf('$4') > -1);
      expect([from, to, uses]).toEqual([from, to, to === 'approved' || to === 'cancelled']);
    }
    expect(R.statusStamps('open', 'open', '$4', '$3')).toEqual([]);
  });
});

describe('normalizeReopenList', () => {
  const BAD = 'One of those buildings is not on this work order.';

  test('refuses a non-list, too many entries and a malformed id', () => {
    expect(R.normalizeReopenList('t782')).toEqual({ ok: false, error: 'Buildings to reopen must be a list.' });
    expect(R.normalizeReopenList(null)).toEqual({ ok: false, error: 'Buildings to reopen must be a list.' });
    expect(R.normalizeReopenList(Array.from({ length: 201 }, (_, i) => 't' + i)))
      .toEqual({ ok: false, error: 'Too many buildings in one send-back.' });
    expect(R.normalizeReopenList(Array.from({ length: 200 }, (_, i) => 't' + i)).ok).toBe(true);
    for (const bad of [["t1'; DROP"], ['a/b'], [''], [{ note: 'no id' }], [null], [['t1']], ['x'.repeat(129)], [{ id: {} }]]) {
      expect(R.normalizeReopenList(bad)).toEqual({ ok: false, error: BAD });
    }
  });

  test('ids and {id, note} objects; the first entry for an id wins; notes are cleaned and capped', () => {
    const r = R.normalizeReopenList([' t782 ', { id: 't784', note: '  post\u0000 loose ' },
      { id: 't782', note: 'second copy is ignored' }, { id: 't790', note: '   ' }, { id: 't791', note: 'n'.repeat(900) }]);
    expect(r.ok).toBe(true);
    expect(r.list.slice(0, 3)).toEqual([
      { id: 't782', note: null },
      { id: 't784', note: 'post  loose' },
      { id: 't790', note: null },
    ]);
    expect(r.list[3].id).toBe('t791');
    expect(r.list[3].note.length).toBe(500);
    expect(R.normalizeReopenList([])).toEqual({ ok: true, list: [] });
  });
});

describe('sendBackFromEvent', () => {
  const TASKS = [
    { id: 't782', title: 'Bldg 782 — Side A: adjust metal railing (renamed)' },
    { id: 't784', title: 'Bldg 784 — Side A: replace 1 (4x4) post' },
  ];
  const sendBack = {
    id: 'e2', created_at: '2026-09-15 14:00:00',
    detail: {
      from: 'work_complete', to: 'in_progress', action: 'send_back', note: 'Rail post still loose',
      buildings: [
        { task_id: 't782', title: 'Bldg 782 — old title', note: 'tighten', reopened: true },
        { task_id: 't784', title: 'Bldg 784', note: null, reopened: false },
        { task_id: 'gone', title: 'deleted building', note: 'x', reopened: true },
      ],
    },
  };

  test('a live send-back uses the current titles and drops buildings no longer on the ticket', () => {
    expect(R.sendBackFromEvent(sendBack, 'in_progress', TASKS)).toEqual({
      note: 'Rail post still loose',
      at: '2026-09-15 14:00:00',
      buildings: [
        { id: 't782', title: 'Bldg 782 — Side A: adjust metal railing (renamed)', note: 'tighten', reopened: true },
        { id: 't784', title: 'Bldg 784 — Side A: replace 1 (4x4) post', note: null, reopened: false },
      ],
    });
    // detail as text, the way a driver that does not parse jsonb hands it back
    const asText = Object.assign({}, sendBack, { detail: JSON.stringify(sendBack.detail) });
    expect(R.sendBackFromEvent(asText, 'open', TASKS).buildings.length).toBe(2);
  });

  test('the newest relevant event being an arrival at work_complete means no banner', () => {
    const arrival = { id: 'e3', created_at: '2026-09-16', detail: { from: 'in_progress', to: 'work_complete', reason: 'all_subtasks_done' } };
    expect(R.sendBackFromEvent(arrival, 'in_progress', TASKS)).toBeNull();
    expect(R.sendBackFromEvent(null, 'in_progress', TASKS)).toBeNull();
  });

  test('no banner once the ticket has left the crew band', () => {
    for (const s of ['work_complete', 'approved', 'closed', 'cancelled', 'draft', 'bogus']) {
      expect([s, R.sendBackFromEvent(sendBack, s, TASKS)]).toEqual([s, null]);
    }
    for (const s of ['open', 'scheduled', 'in_progress']) {
      expect(R.sendBackFromEvent(sendBack, s, TASKS)).not.toBeNull();
    }
  });

  test('MUTANT: without the send_back check, the banner survives a re-completion', () => {
    const arrival = { id: 'e3', created_at: '2026-09-16', detail: { from: 'in_progress', to: 'work_complete' } };
    const M = mutant("  if (!detail || detail.action !== 'send_back') return null;\n", '  if (!detail) return null;\n');
    expect(M.sendBackFromEvent(arrival, 'in_progress', TASKS)).not.toBeNull();
    expect(R.sendBackFromEvent(arrival, 'in_progress', TASKS)).toBeNull();
  });

  test('MUTANT: without the crew-band check, a cancelled ticket still shows the banner', () => {
    const M = mutant('  if (CREW_BAND.indexOf(statusOf(ticketStatus)) < 0) return null;\n', '');
    expect(M.sendBackFromEvent(sendBack, 'cancelled', TASKS)).not.toBeNull();
    expect(R.sendBackFromEvent(sendBack, 'cancelled', TASKS)).toBeNull();
  });
});

describe('the readers, over the real schema with a second org', () => {
  function seed() {
    eng.db.exec(`
      DELETE FROM organizations; DELETE FROM users; DELETE FROM service_ticket_events;
      INSERT INTO organizations (id, name) VALUES (1, 'AGX'), (2, 'Rival');
      INSERT INTO users (id, name, email, role, organization_id) VALUES
        (10, 'Jason Salinas', 'j@agx.test', 'pm', 1),
        (11, 'Dana Office', 'd@agx.test', 'admin', 1),
        (50, 'Ray Rival', 'r@rival.test', 'pm', 2);
    `);
  }
  function ev(id, org, ticketId, kind, detail, at) {
    eng.db.prepare(
      "INSERT INTO service_ticket_events (id, organization_id, ticket_id, kind, actor_kind, detail, created_at) VALUES (?, ?, ?, ?, 'user', ?, ?)"
    ).run(id, org, ticketId, kind, JSON.stringify(detail), at);
  }
  beforeEach(seed);

  const TASKS = [{ id: 't782', title: 'Bldg 782 — Side A' }];
  const SEND_BACK = { from: 'work_complete', to: 'in_progress', action: 'send_back', note: 'Redo the rail',
    buildings: [{ task_id: 't782', title: 'Bldg 782', note: null, reopened: true }] };

  test('activeSendBack returns the send-back until the next arrival at work_complete', async () => {
    const ticket = { id: 'st1', organization_id: 1, status: 'in_progress' };
    ev('e1', 1, 'st1', 'status_changed', { from: 'in_progress', to: 'work_complete', reason: 'marked_complete' }, '2026-09-15 10:00:00');
    ev('e2', 1, 'st1', 'status_changed', SEND_BACK, '2026-09-15 11:00:00');
    ev('e3', 1, 'st1', 'note_added', {}, '2026-09-15 12:00:00');
    const live = await R.activeSendBack(eng.pool, ticket, TASKS);
    expect(live).toEqual({ note: 'Redo the rail', at: '2026-09-15 11:00:00',
      buildings: [{ id: 't782', title: 'Bldg 782 — Side A', note: null, reopened: true }] });

    // The crew finishes again and then undoes it: the newest relevant event is
    // the arrival, so the old send-back does not come back.
    ev('e4', 1, 'st1', 'status_changed', { from: 'in_progress', to: 'work_complete', reason: 'all_subtasks_done' }, '2026-09-15 13:00:00');
    ev('e5', 1, 'st1', 'status_changed', { from: 'work_complete', to: 'in_progress', reason: 'subtask_reopened' }, '2026-09-15 14:00:00');
    expect(await R.activeSendBack(eng.pool, ticket, TASKS)).toBeNull();
  });

  test('another org\'s send-back on the same ticket id is not this ticket\'s banner', async () => {
    ev('x1', 2, 'st1', 'status_changed', SEND_BACK, '2026-09-15 11:00:00');
    expect(await R.activeSendBack(eng.pool, { id: 'st1', organization_id: 1, status: 'in_progress' }, TASKS)).toBeNull();
    expect(await R.activeSendBack(eng.pool, { id: 'st1', organization_id: 2, status: 'in_progress' }, TASKS)).not.toBeNull();
  });

  test('activeSendBack runs no query outside the crew band', async () => {
    ev('e2', 1, 'st1', 'status_changed', SEND_BACK, '2026-09-15 11:00:00');
    const before = eng.log.length;
    for (const s of ['work_complete', 'approved', 'closed', 'cancelled']) {
      expect(await R.activeSendBack(eng.pool, { id: 'st1', organization_id: 1, status: s }, TASKS)).toBeNull();
    }
    expect(eng.log.length).toBe(before);
  });

  test('peopleNames names in-org users only, and skips the query when there is nobody to name', async () => {
    expect(await R.peopleNames(eng.pool, 1, [10, 50, null, '11', 10])).toEqual({ 10: 'Jason Salinas', 11: 'Dana Office' });
    expect(await R.peopleNames(eng.pool, 2, [10, 50])).toEqual({ 50: 'Ray Rival' });
    const before = eng.log.length;
    expect(await R.peopleNames(eng.pool, 1, [null, undefined, ''])).toEqual({});
    expect(await R.peopleNames(eng.pool, null, [10])).toEqual({});
    expect(eng.log.length).toBe(before);
    const last = eng.log.slice(-1)[0];
    expect(last.sql).toMatch(/organization_id = \$2/);
  });

  test('MUTANT: without the org predicate, peopleNames would name another tenant\'s user', async () => {
    const M = mutant("    'SELECT id, name FROM users WHERE id = ANY($1::int[]) AND organization_id = $2',\n",
      "    'SELECT id, name FROM users WHERE id = ANY($1::int[]) AND $2 = $2',\n");
    expect(await M.peopleNames(eng.pool, 1, [10, 50])).toEqual({ 10: 'Jason Salinas', 50: 'Ray Rival' });
    expect(await R.peopleNames(eng.pool, 1, [10, 50])).toEqual({ 10: 'Jason Salinas' });
  });
});
