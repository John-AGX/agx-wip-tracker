// Deleting a job: the server is asked FIRST, and the answer is what the screen
// reports.
//
// All three job-delete paths used to filter appData, call saveData(), navigate
// away, and fire DELETE /api/jobs/:id as forget-and-swallow into a
// console.warn. The bulk path went further and toasted "Deleted N job(s)."
// before a single request had resolved. Both are the same defect the save path
// was just fixed for: the UI reporting an outcome nobody checked.
//
// The consequence is not cosmetic. A DELETE that fails (a 502 mid-deploy, a
// 403 on a job this user cannot edit) leaves the row gone from the screen and
// present in Postgres — so it returns on the next hydrate, looking like the app
// undid the user's action. And nothing can be built on "this row was deleted"
// while the claim is unverified.
//
// js/jobs.js is ~7000 lines of DOM-bound top-level script with no export seam,
// so these are SOURCE checks. That is a real limitation and worth naming: they
// pin the ORDER and the absence of the swallow, not the runtime behaviour. The
// runtime property they protect — that a stale local copy is never re-uploaded
// — is covered end to end in test/save-path.test.js.

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'js', 'jobs.js'), 'utf8')
  .replace(/\r\n?/g, '\n');
const EST = fs.readFileSync(path.join(__dirname, '..', 'js', 'estimates.js'), 'utf8')
  .replace(/\r\n?/g, '\n');

// Line comments only — several blocks below quote the pattern they forbid.
const code = SRC.split('\n').map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');

describe('job deletes go through one helper, server first', () => {
  test('there is exactly one place that calls jobs.remove', () => {
    // Three call sites meant three chances to get the ordering wrong, and the
    // archived path and the bulk path had already drifted apart from each
    // other in how much they cleaned up.
    const calls = code.match(/p86Api\.jobs\.remove\(/g) || [];
    expect(calls).toHaveLength(1);
    const helper = code.slice(code.indexOf('function deleteJobsOnServer('));
    expect(helper.slice(0, 900)).toMatch(/p86Api\.jobs\.remove\(/);
  });

  test('no delete path swallows the failure into a console.warn', () => {
    expect(code).not.toMatch(/Server delete failed/);
    const helper = code.slice(code.indexOf('function deleteJobsOnServer('),
                              code.indexOf('function reportJobDeleteFailures('));
    // A rejection is collected and returned, not logged and forgotten.
    expect(helper).toMatch(/failed\.push\(/);
    expect(helper).not.toMatch(/console\.warn/);
  });

  test('a 404 counts as success — the row is gone, which is what was asked', () => {
    const helper = code.slice(code.indexOf('function deleteJobsOnServer('),
                              code.indexOf('function reportJobDeleteFailures('));
    expect(helper).toMatch(/err\.status === 404/);
    expect(helper).toMatch(/ok\.push\(id\)/);
  });

  test('local teardown only ever runs on ids the server CONFIRMED', () => {
    // purgeJobsLocally(res.ok) — never purgeJobsLocally(ids). Purging the
    // requested ids instead of the confirmed ones is exactly the bug, moved.
    // Lookbehind excludes the declaration itself, which takes `ids`.
    const purgeCalls = code.match(/(?<!function )purgeJobsLocally\([^)]*\)/g) || [];
    expect(purgeCalls.length).toBe(3);
    expect(purgeCalls.filter((c) => /res\.ok/.test(c)).length).toBe(3);
  });

  test('every delete path reports its failures', () => {
    // One report call per delete path. A path that purges without reporting is
    // a path that can fail silently.
    expect((code.match(/reportJobDeleteFailures\(res\.failed\)/g) || []).length).toBe(3);
  });

  test('the bulk toast counts what the SERVER accepted, not what was asked', () => {
    expect(code).toMatch(/window\.p86Toast\('Deleted ' \+ res\.ok\.length/);
    expect(code).not.toMatch(/window\.p86Toast\('Deleted ' \+ ids\.length/);
  });

  test('this is the pattern estimates already use — jobs were the outlier', () => {
    // The reference implementation: server remove, THEN removeLocal, with 404
    // tolerated and anything else surfaced to the user.
    //
    // Asserted as ORDER, not as characters. This once required the literal
    // `.then(removeLocal)` on the next line and went red when that became
    // `.then(function() { removeLocal(); return true; })` — the same order,
    // just returning a value to the chain. A test that fails on a benign
    // refactor of the code it points AT teaches people to edit the test.
    const call = EST.indexOf('estimates.remove(estId)');
    expect(call).toBeGreaterThan(-1);
    const chain = EST.slice(call, call + 900);

    // removeLocal runs inside the .then — after the server confirmed, never before.
    const then = chain.indexOf('.then(');
    const local = chain.indexOf('removeLocal()');
    expect(then).toBeGreaterThan(-1);
    expect(local).toBeGreaterThan(then);

    // 404 means the row is already gone, so the local teardown still runs.
    const c404 = chain.indexOf('err.status === 404');
    expect(c404).toBeGreaterThan(-1);
    expect(chain.slice(c404, c404 + 120)).toMatch(/removeLocal\(\)/);

    // Anything else is surfaced. Silently swallowing it is the bug this guards.
    expect(chain).toMatch(/Delete failed/);
  });
});

// ── A JOB WITH WORK ORDERS (A4) ────────────────────────────────────────────
// The server now refuses a job delete that would cascade its service tickets:
// 409 OPEN_TICKETS for an open one, 409 CLOSED_TICKETS {tickets} for closed,
// cancelled or archived ones until ?confirm_closed_tickets=N echoes the count.
//
// The helper is small and self-contained, so beyond the source checks it is
// LIFTED from js/jobs.js and RUN against a fake p86Api and a recorded dialog:
// the claims below are about what it does, in order, not about its text. A
// mutant copy of the lifted source is shown to go red for each named rule.
describe('a job with service tickets: one question, then a second pass', () => {
  const helperSrc = (src) => {
    const from = src.indexOf('function deleteJobsOnServer(');
    const to = src.indexOf('function reportJobDeleteFailures(');
    if (from < 0 || to < from) throw new Error('helper not found');
    return src.slice(from, to);
  };
  const HELPER = helperSrc(SRC);

  function lift(source) {
    // eslint-disable-next-line no-new-func
    return new Function('window', 'appData', '_confirmDelete',
      source + '\nreturn deleteJobsOnServer;');
  }

  function mutantHelper(find, replace) {
    if (HELPER.split(find).length - 1 !== 1) throw new Error('anchor not found: ' + find);
    return HELPER.split(find).join(replace);
  }

  const err = (status, data) => {
    const e = new Error((data && data.error) || ('HTTP ' + status));
    e.status = status;
    e.data = data || null;
    return e;
  };
  const OPEN_MSG = 'This job has 1 open service ticket. Close or archive it before deleting the job.';
  const closed = (tickets) => err(409, {
    error: 'This job has ' + tickets.total + ' closed, cancelled or archived service tickets.',
    code: 'CLOSED_TICKETS', tickets,
  });

  // answers[id] = list of responses, one per call, in order: 'ok' or an Error.
  function harness(answers, opts) {
    const o = opts || {};
    const calls = [];
    const log = [];
    const dialogs = [];
    const window = {
      p86Api: {
        isAuthenticated: () => true,
        jobs: {
          remove(id, removeOpts) {
            calls.push({ id, opts: removeOpts });
            log.push('remove:' + id + (removeOpts ? ':' + removeOpts.confirmClosedTickets : ''));
            const next = (answers[id] || []).shift();
            return next === 'ok' || next === undefined ? Promise.resolve({ ok: true }) : Promise.reject(next);
          },
        },
      },
    };
    const appData = { jobs: o.jobs || [] };
    const confirm = (label, dialog) => {
      dialogs.push(dialog);
      log.push('confirm');
      return Promise.resolve(o.yes !== false);
    };
    const run = lift(o.source || HELPER)(window, appData, confirm);
    return { run, calls, log, dialogs };
  }

  test('the helper still holds exactly one remove( call and names both codes', () => {
    const calls = code.match(/p86Api\.jobs\.remove\(/g) || [];
    expect(calls).toHaveLength(1);
    const helper = code.slice(code.indexOf('function deleteJobsOnServer('),
                              code.indexOf('function reportJobDeleteFailures('));
    expect(helper).toMatch(/function removeOne\(id, confirm\)/);
    expect(helper).toMatch(/'CLOSED_TICKETS'/);
    // The confirmation comes BEFORE the second pass in the source as well.
    const ask = helper.indexOf('_confirmDelete(');
    const second = helper.indexOf('removeOne(w.id, w.tickets.total)');
    expect(ask).toBeGreaterThan(helper.indexOf("'CLOSED_TICKETS'"));
    expect(second).toBeGreaterThan(ask);
  });

  test('OPEN_TICKETS goes to failed with the server sentence, no question asked', async () => {
    const h = harness({ j1: [err(409, { error: OPEN_MSG, code: 'OPEN_TICKETS', openTicketCount: 1 })] });
    const res = await h.run(['j1']);
    expect(res).toEqual({ ok: [], failed: [{ id: 'j1', message: OPEN_MSG }] });
    expect(h.dialogs).toHaveLength(0);
    expect(h.calls).toHaveLength(1);
  });

  test('a 404 is still ok and a 500 still fails, beside a ticket refusal', async () => {
    const h = harness({
      gone: [err(404, { error: 'Job not found' })],
      boom: [err(500, { error: 'Server error' })],
    });
    const res = await h.run(['gone', 'boom']);
    expect(res.ok).toEqual(['gone']);
    expect(res.failed).toEqual([{ id: 'boom', message: 'Server error' }]);
    expect(h.dialogs).toHaveLength(0);
  });

  test('one job with closed tickets: the exact question, asked before the second pass, which carries the count', async () => {
    const h = harness(
      { j1: [closed({ total: 4, closed: 2, cancelled: 1, archived: 1 }), 'ok'] },
      { jobs: [{ id: 'j1', title: 'Maple St reroof' }] });
    const res = await h.run(['j1']);
    expect(h.dialogs).toEqual([{
      title: 'Delete service tickets too?',
      message: '"Maple St reroof" has 4 service tickets that are closed, cancelled or archived (2 closed, 1 cancelled, 1 archived). Deleting the job deletes them for good, with their approval history, timeline and crew links. This cannot be undone.',
      confirmLabel: 'Delete job and 4 tickets',
    }]);
    expect(h.log).toEqual(['remove:j1', 'confirm', 'remove:j1:4']);
    expect(h.calls[0].opts).toBeUndefined();
    expect(h.calls[1].opts).toEqual({ confirmClosedTickets: 4 });
    expect(res).toEqual({ ok: ['j1'], failed: [] });
  });

  test('several jobs: ONE question for the batch, then only those jobs go again', async () => {
    const h = harness({
      a: [closed({ total: 2, closed: 2, cancelled: 0, archived: 0 }), 'ok'],
      b: ['ok'],
      c: [closed({ total: 4, closed: 1, cancelled: 1, archived: 2 }), 'ok'],
      d: [closed({ total: 3, closed: 0, cancelled: 0, archived: 3 }), 'ok'],
    });
    const res = await h.run(['a', 'b', 'c', 'd']);
    expect(h.dialogs).toEqual([{
      title: 'Delete service tickets too?',
      message: '3 of these jobs have closed, cancelled or archived service tickets (9 in total). Deleting those jobs deletes the tickets for good, with their approval history, timeline and crew links. This cannot be undone.',
      confirmLabel: 'Delete them too',
    }]);
    expect(h.log.indexOf('confirm')).toBe(4);   // after all four first-pass calls
    expect(h.log.slice(5).sort()).toEqual(['remove:a:2', 'remove:c:4', 'remove:d:3']);
    expect(res.ok.sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(res.failed).toEqual([]);
  });

  test('No: those jobs are reported as kept, and nothing is sent again', async () => {
    const h = harness({ j1: [closed({ total: 1, closed: 1, cancelled: 0, archived: 0 })] },
      { yes: false, jobs: [{ id: 'j1', name: 'Oak job' }] });
    const res = await h.run(['j1']);
    expect(h.dialogs[0].message).toBe('"Oak job" has 1 service ticket that is closed, cancelled or archived (1 closed). Deleting the job deletes it for good, with its approval history, timeline and crew links. This cannot be undone.');
    expect(h.dialogs[0].confirmLabel).toBe('Delete job and 1 ticket');
    expect(h.calls).toHaveLength(1);
    expect(res).toEqual({ ok: [], failed: [{ id: 'j1', message: 'Not deleted — it has service tickets you chose to keep.' }] });
  });

  test('a count that changed before the second pass fails by name, with no second question', async () => {
    const h = harness({ j1: [closed({ total: 2, closed: 2, cancelled: 0, archived: 0 }),
      closed({ total: 3, closed: 3, cancelled: 0, archived: 0 })] });
    const res = await h.run(['j1']);
    expect(h.dialogs).toHaveLength(1);
    expect(res.ok).toEqual([]);
    expect(res.failed).toEqual([{ id: 'j1', message: 'This job has 3 closed, cancelled or archived service tickets.' }]);
  });

  test('MUTANT: an OPEN_TICKETS refusal treated like CLOSED_TICKETS gets a delete question', async () => {
    const src = mutantHelper("data.code === 'CLOSED_TICKETS'", '/_TICKETS$/.test(data.code)');
    const h = harness({ j1: [err(409, { error: OPEN_MSG, code: 'OPEN_TICKETS', openTicketCount: 1, tickets: { total: 1 } })] },
      { source: src, yes: false });
    const res = await h.run(['j1']);
    expect(h.dialogs).toHaveLength(1);
    expect(res.failed[0].message).not.toBe(OPEN_MSG);
  });

  test('MUTANT: skipping the question sends the confirmed count nobody agreed to', async () => {
    const src = mutantHelper("return _confirmDelete('service tickets', closedTicketsConfirm(withTickets))",
      "return Promise.resolve(true)");
    const h = harness({ j1: [closed({ total: 4, closed: 4, cancelled: 0, archived: 0 }), 'ok'] },
      { source: src, yes: false });
    const res = await h.run(['j1']);
    expect(h.dialogs).toHaveLength(0);
    expect(h.log).toEqual(['remove:j1', 'remove:j1:4']);
    expect(res.ok).toEqual(['j1']);
  });

  test('MUTANT: without the first-pass-only rule a changed count vanishes from both lists', async () => {
    const src = mutantHelper('if (confirm == null && err && err.status === 409', 'if (err && err.status === 409');
    const h = harness({ j1: [closed({ total: 2, closed: 2, cancelled: 0, archived: 0 }),
      closed({ total: 3, closed: 3, cancelled: 0, archived: 0 })] }, { source: src });
    const res = await h.run(['j1']);
    expect(res).toEqual({ ok: [], failed: [] });
  });

  test('MUTANT: a No that forgets to report leaves the job silently undeleted', async () => {
    const src = mutantHelper("failed.push({ id: w.id, message: 'Not deleted — it has service tickets you chose to keep.' });", '');
    const h = harness({ j1: [closed({ total: 1, closed: 1, cancelled: 0, archived: 0 })] }, { source: src, yes: false });
    const res = await h.run(['j1']);
    expect(res).toEqual({ ok: [], failed: [] });
  });
});
