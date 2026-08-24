// test/line-delete-is-by-address.test.js — deleting by id must remove ONE line.
//
// THE REGRESSION. d39f2212 made an id a string on both sides of the lookup,
// which was right and fixed a row an agent could create and nobody could edit.
// But applyLineDeletes collected the references into a Set and ran a FILTER:
//
//     data.lines = lines.filter(l => !l || l.id == null || !ids.has(String(l.id)))
//
// A filter removes EVERY match. Once both sides were coerced, a stored NUMBER 7
// and a stored STRING "7" became the same address, so one reference took two
// lines. Measured on the shipped code before this fix:
//
//     duplicate string ids, delete one     removed=2   (both gone)
//     number 7 vs string "7", delete "7"   removed=2   (both gone)
//     unique ids, delete one               removed=1   (correct)
//
// Duplicate STRING ids had always behaved that way; the coercion widened what
// counts as a duplicate. Either way an agent asked to delete one line deleted
// two, on records that carry money, and reported an honest count of what it had
// actually done — so the summary did not read as wrong.
//
// WHY IT IS REACHABLE. The browser heals duplicates at its state boundary, so
// the editor cannot produce a collision. The SERVER has no such boundary — the
// blob is stored verbatim through the agent door — so a collision arrives here
// and this path must not treat it as permission to remove more than was asked.
//
// THE RULE. Deleting by address is not deleting by predicate. One reference
// removes at most one line; N references remove at most N. A broken record is
// a reason to remove less, never more.

const fs = require('fs');
const path = require('path');

// Extract the shipped function rather than importing the module, which pulls a
// DB pool. Brace-matched from source so the test cannot drift from the file.
function loadApplyLineDeletes() {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'server', 'services', 'payload-dispatcher.js'), 'utf8');
  const at = src.indexOf('function applyLineDeletes');
  expect(at).toBeGreaterThan(-1);
  let depth = 0, end = -1;
  for (let i = src.indexOf('{', at); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  expect(end).toBeGreaterThan(at);
  const ensureArray = (d, k) => (Array.isArray(d[k]) ? d[k] : (d[k] = []));
  return new Function('ensureArray', 'return ' + src.slice(at, end))(ensureArray);
}

const applyLineDeletes = loadApplyLineDeletes();

const run = (lines, dels) => {
  const data = { lines: JSON.parse(JSON.stringify(lines)) };
  const removed = applyLineDeletes(data, dels);
  return { removed, left: data.lines.map((l) => (l ? (l.description || String(l.id)) : 'HOLE')) };
};

describe('one reference removes at most one line', () => {
  test('duplicate string ids — a single reference takes ONE', () => {
    const r = run(
      [{ id: 'L1', description: 'a' }, { id: 'L1', description: 'b' }, { id: 'L2', description: 'c' }],
      [{ line_id: 'L1' }]);
    expect(r.removed).toBe(1);
    expect(r.left).toEqual(['b', 'c']);
  });

  test('a stored NUMBER and a stored STRING that coerce alike — takes ONE', () => {
    // This is the shape d39f2212 created: the agent door stores line_id
    // verbatim, so 7 and "7" can both exist on one record.
    const r = run(
      [{ id: 7, description: 'num7' }, { id: '7', description: 'str7' }, { id: 'L2', description: 'c' }],
      [{ line_id: '7' }]);
    expect(r.removed).toBe(1);
    expect(r.left).toEqual(['str7', 'c']);
  });

  test('the FIRST match goes, so the order of what remains is predictable', () => {
    const r = run(
      [{ id: 'X', description: 'first' }, { id: 'X', description: 'second' }],
      [{ line_id: 'X' }]);
    expect(r.left).toEqual(['second']);
  });

  test('N references remove N — two references to a duplicated address take both', () => {
    const r = run(
      [{ id: 'L1', description: 'a' }, { id: 'L1', description: 'b' }, { id: 'L2', description: 'c' }],
      [{ line_id: 'L1' }, { line_id: 'L1' }]);
    expect(r.removed).toBe(2);
    expect(r.left).toEqual(['c']);
  });

  test('three references against two duplicates still take only two', () => {
    const r = run(
      [{ id: 'L1', description: 'a' }, { id: 'L1', description: 'b' }],
      [{ line_id: 'L1' }, { line_id: 'L1' }, { line_id: 'L1' }]);
    expect(r.removed).toBe(2);
    expect(r.left).toEqual([]);
  });
});

describe('what the coercion was for still works', () => {
  test('a string reference resolves a stored number', () => {
    const r = run([{ id: 7, description: 'num7' }, { id: 'L2', description: 'b' }], [{ line_id: '7' }]);
    expect(r.removed).toBe(1);
    expect(r.left).toEqual(['b']);
  });

  test('a numeric reference resolves a stored number', () => {
    const r = run([{ id: 7, description: 'num7' }, { id: 'L2', description: 'b' }], [7]);
    expect(r.removed).toBe(1);
  });

  test('id 0 is an address, not a falsy nothing', () => {
    const r = run([{ id: 0, description: 'zero' }, { id: 'L2', description: 'b' }], [{ line_id: 0 }]);
    expect(r.removed).toBe(1);
    expect(r.left).toEqual(['b']);
  });

  test('a bare id string is accepted as a reference', () => {
    expect(run([{ id: 'L1', description: 'a' }], ['L1']).removed).toBe(1);
  });
});

describe('it removes less rather than more', () => {
  test('a reference matching nothing removes nothing', () => {
    const r = run([{ id: 'L1', description: 'a' }], [{ line_id: 'nope' }]);
    expect(r.removed).toBe(0);
    expect(r.left).toEqual(['a']);
  });

  test.each([[''], ['   '], [null], [undefined]])(
    'an empty reference (%p) removes nothing — it must never match a blank id', (ref) => {
      const r = run([{ id: 'L1', description: 'a' }, { id: '', description: 'blank' }], [{ line_id: ref }]);
      expect(r.removed).toBe(0);
      expect(r.left).toEqual(['a', 'blank']);
    });

  test('a stored null hole is KEPT — removing it would reindex the array', () => {
    // Section membership on an estimate IS array position. Dropping a hole
    // here would re-section the record and move money between scopes while
    // the cost total sat still.
    const r = run(
      [{ id: 'L1', description: 'a' }, null, { id: 'L2', description: 'b' }],
      [{ line_id: 'L1' }]);
    expect(r.removed).toBe(1);
    expect(r.left).toEqual(['HOLE', 'b']);
  });

  test('a line with no id is never matched by any reference', () => {
    const r = run([{ description: 'idless' }, { id: 'L1', description: 'a' }], [{ line_id: 'L1' }]);
    expect(r.left).toEqual(['idless']);
  });

  test('the returned count is what was ACTUALLY removed, not what was asked', () => {
    const r = run([{ id: 'L1', description: 'a' }], [{ line_id: 'L1' }, { line_id: 'ghost' }]);
    expect(r.removed).toBe(1);
  });
});

describe('order is never disturbed', () => {
  test('deleting from the middle leaves the rest in position', () => {
    const r = run(
      [{ id: 'A', description: '1' }, { id: 'B', description: '2' },
       { id: 'C', description: '3' }, { id: 'D', description: '4' }],
      [{ line_id: 'B' }, { line_id: 'D' }]);
    expect(r.removed).toBe(2);
    expect(r.left).toEqual(['1', '3']);
  });

  test('references given out of order still delete the right lines', () => {
    const r = run(
      [{ id: 'A', description: '1' }, { id: 'B', description: '2' }, { id: 'C', description: '3' }],
      [{ line_id: 'C' }, { line_id: 'A' }]);
    expect(r.left).toEqual(['2']);
  });
});

describe('the shape of the fix is pinned', () => {
  const SRC = fs.readFileSync(
    path.join(__dirname, '..', 'server', 'services', 'payload-dispatcher.js'), 'utf8');
  const body = (() => {
    const at = SRC.indexOf('function applyLineDeletes');
    return SRC.slice(at, SRC.indexOf('\n}', at));
  })();

  test('it does not filter every match out in one pass', () => {
    // The regression in one line. A future tidy-up back to `ids.has(...)`
    // inside a filter reintroduces exactly this bug, silently.
    expect(body).not.toMatch(/lines\.filter\([^)]*ids\.has/);
  });

  test('matches are marked by index before anything is removed', () => {
    expect(body).toContain('doomed');
    expect(body).toMatch(/findIndex/);
  });
});
