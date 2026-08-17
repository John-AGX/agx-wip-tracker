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
    // The reference implementation, unchanged: server remove, THEN removeLocal,
    // with 404 tolerated and anything else surfaced to the user.
    expect(EST).toMatch(/estimates\.remove\(estId\)\s*\n\s*\.then\(removeLocal\)/);
    expect(EST).toMatch(/err\.status === 404.*removeLocal\(\); return;/);
  });
});
