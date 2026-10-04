'use strict';

// WHY THIS FILE EXISTS
//
// agent-eval-corpus.js claims that "48 of 696 assistant turns end in a visible
// failure" is a DERIVED number rather than a human reading transcripts. That
// claim is only worth anything if the classifier agrees with the strings
// ai-routes.js actually writes — so this suite reads those strings out of the
// source and asserts the buckets match. A vocabulary that drifts from its
// producer empties silently into `other`, which is the exact failure mode the
// taxonomy exists to replace, so the drift is pinned rather than hoped for.
//
// The module is pure, like services/usage-ledger.js beside it, so none of this
// needs a database.

const fs = require('fs');
const os = require('os');
const path = require('path');

const corpus = require('../server/services/agent-eval-corpus');

const AI_ROUTES = path.join(__dirname, '..', 'server', 'routes', 'ai-routes.js');
const CORPUS = path.join(__dirname, '..', 'server', 'services', 'agent-eval-corpus.js');
const SRC = fs.readFileSync(AI_ROUTES, 'utf8');

// persistTurnError's exact shape: the sign, then the message, optionally after
// whatever partial text had already streamed. Rebuilt here rather than
// imported, so a change to that join shows up as a failure here.
const SIGN = String.fromCharCode(0x26A0) + String.fromCharCode(0xFE0F);
const failed = (message, partial) =>
  (partial ? String(partial).trimEnd() + '\n\n' : '') + SIGN + ' ' + message;

describe('what counts as a failed turn', () => {
  test('a turn with no warning sign is not a failure, whatever it says', () => {
    // The denominator depends on this: an assistant turn that merely discusses
    // an error is not a failed turn.
    for (const body of [
      'Three jobs are over budget.',
      'That job does not exist.',
      'I could not find a lead matching "Windermere".',
      'The apply failed earlier today, so I checked the current state first.',
      '', null, undefined, 42, {},
    ]) {
      expect(corpus.isFailure(body)).toBe(false);
      expect(corpus.classifyFailure(body)).toBeNull();
    }
  });

  test('the sign is matched without the variation selector', () => {
    // psql, some editors and some consoles drop U+FE0F. Only the base
    // character is reliable, and the SQL predicate uses chr(9888) for the same
    // reason — so the two must agree on which character is load-bearing.
    const bare = String.fromCharCode(0x26A0) + ' 86 stopped responding and this turn was ended after 5 minutes.';
    expect(corpus.isFailure(bare)).toBe(true);
    expect(corpus.classifyFailure(bare)).toBe('idle_watchdog');
    expect(corpus.corpusSql()).toContain('chr(9888)');
  });

  test('partial text before the sign is not classified', () => {
    // A user quoting "duplicate key" at 86, on a turn that then died of
    // something else, must not land in raw_db_error_leaked.
    const body = failed(
      '86 stopped responding and this turn was ended after 5 minutes with no output.',
      'You asked about the duplicate key error from yesterday.'
    );
    expect(corpus.classifyFailure(body)).toBe('idle_watchdog');
    expect(corpus.failureMessage(body)).toMatch(/^86 stopped responding/);
  });
});

describe('the vocabulary matches what ai-routes.js writes', () => {
  // Each entry: the literal the producer writes, and the bucket it must land
  // in. The literal is asserted PRESENT IN THE SOURCE first, so rewording the
  // producer fails here instead of quietly emptying a bucket.
  const CONTRACT = [
    ['86 stopped responding and this turn was ended after ', 'idle_watchdog'],
    ['Your approved change was already applied and is saved', 'stalled_mid_approval'],
    [' approved changes were already applied and are saved', 'stalled_mid_approval'],
    ['Do NOT re-send this approval blind', 'stalled_mid_approval'],
    ['Failed to open session stream', 'stream_open_failed'],
  ];

  test.each(CONTRACT)('%p still exists in ai-routes.js', (literal) => {
    expect(SRC).toContain(literal);
  });

  test.each(CONTRACT)('%p classifies as %s', (literal, kind) => {
    expect(corpus.classifyFailure(failed(literal + ' …'))).toBe(kind);
  });

  test('a leaked Postgres message is its own bucket, by shape not by literal', () => {
    // These are never written on purpose, so there is no producer literal to
    // pin — the patterns have to recognise the shapes Postgres emits.
    const pg = [
      'duplicate key value violates unique constraint "tasks_pkey"',
      'null value in column "title" violates not-null constraint',
      'relation "job_phase" does not exist',
      'syntax error at or near "FROM"',
    ];
    for (const m of pg) expect(corpus.classifyFailure(failed(m))).toBe('raw_db_error_leaked');
  });

  test('an unrecognised failure is `other`, never dropped', () => {
    // The count must stay honest when a new failure path appears. A rising
    // `other` is the signal that the vocabulary needs extending.
    expect(corpus.classifyFailure(failed('Something nobody has seen before.'))).toBe('other');
  });

  test('every declared kind is reachable, and no two share a name', () => {
    // Vacuity guard: a bucket whose predicate can never fire is worse than no
    // bucket, because it reads as "this never happens".
    const names = corpus.FAILURE_KINDS.map(k => k.kind);
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBeGreaterThanOrEqual(6);
    for (const k of corpus.FAILURE_KINDS) {
      expect(typeof k.test).toBe('function');
      expect(String(k.why || '').length).toBeGreaterThan(20);
    }
  });
});

describe('the report', () => {
  const rows = [
    { content: failed('86 stopped responding and this turn was ended after 5 minutes.'), created_at: '2026-09-02T10:00:00Z' },
    { content: failed('86 stopped responding and this turn was ended after 5 minutes.'), created_at: '2026-09-20T10:00:00Z' },
    { content: failed('Your approved change was already applied and is saved.'), created_at: '2026-09-10T10:00:00Z' },
    { content: failed('duplicate key value violates unique constraint "tasks_pkey"'), created_at: '2026-09-11T10:00:00Z' },
    { content: failed('Brand new wording nobody has classified.'), created_at: '2026-09-12T10:00:00Z' },
  ];

  test('counts each turn once and ranks the buckets', () => {
    const r = corpus.buildFailureReport(rows, 100);
    expect(r.failed_turns).toBe(5);
    expect(r.kinds.reduce((n, k) => n + k.turns, 0)).toBe(5);
    expect(r.kinds[0]).toMatchObject({ kind: 'idle_watchdog', turns: 2 });
    expect(r.failure_pct).toBe(5);
  });

  test('reports first and last seen per bucket, so a repaired bucket is visible', () => {
    // This is the arm that would have caught the staleness: a bucket whose
    // last_seen predates the window's end has been fixed.
    const r = corpus.buildFailureReport(rows, 100);
    const idle = r.kinds.find(k => k.kind === 'idle_watchdog');
    expect(idle.first_seen).toBe('2026-09-02T10:00:00Z');
    expect(idle.last_seen).toBe('2026-09-20T10:00:00Z');
  });

  test('surfaces the unclassified count separately', () => {
    const r = corpus.buildFailureReport(rows, 100);
    expect(r.unclassified_turns).toBe(1);
  });

  test('an empty bucket is omitted rather than reported as zero', () => {
    const r = corpus.buildFailureReport(
      [{ content: failed('Failed to open session stream'), created_at: '2026-09-01T00:00:00Z' }], 10);
    expect(r.kinds.map(k => k.kind)).toEqual(['stream_open_failed']);
  });

  test('an unknown denominator gives a null rate, not zero', () => {
    // A rate of 0 and "we did not count the turns" are different claims, and
    // this file exists because one was read as the other.
    const r = corpus.buildFailureReport(rows, undefined);
    expect(r.failed_turns).toBe(5);
    expect(r.assistant_turns).toBeNull();
    expect(r.failure_pct).toBeNull();
  });

  test('survives junk rows without inventing failures', () => {
    const r = corpus.buildFailureReport([null, {}, { content: 'fine' }, undefined], 4);
    expect(r.failed_turns).toBe(4);           // it was handed 4 rows
    expect(r.unclassified_turns).toBe(4);     // and could classify none of them
  });
});

describe('the no-usage split stops double-counting failures', () => {
  test('failed turns are their own arm, because they are NULL by design', () => {
    // persistTurnError passes usage = null deliberately. Counting those as an
    // undercount reports the same turns twice: once as "missing measurement"
    // and once as a failure.
    const sql = corpus.noUsageSplitSql();
    expect(sql).toContain('failed_turns_null_by_design');
    expect(sql).toContain('falsy_zero_artifact');
    expect(sql).toContain('genuinely_unrecorded');
    // and the genuine arm must exclude both of the other two
    const genuine = sql.slice(sql.indexOf('genuinely_unrecorded') - 420, sql.indexOf('genuinely_unrecorded'));
    expect(genuine).toContain('cache_read_input_tokens IS NULL');
    expect(genuine).toContain('= 0');
  });

  test('persistTurnError really does pass null usage', () => {
    // The arm above is only correct while this is true.
    expect(SRC).toContain('a failed turn has no trustworthy token accounting');
  });

  test('the monthly query is unwindowed', () => {
    // A windowed rate cannot show its own bucket being repaired mid-window,
    // which is the whole reason this arm exists.
    const sql = corpus.rateByMonthSql();
    expect(sql).toContain("date_trunc('month'");
    expect(sql).not.toContain('$1');
  });
});

describe('the route actually reads this module', () => {
  // Guard against the repo's worst recurring class: a service nobody calls.
  const ROUTE = fs.readFileSync(
    path.join(__dirname, '..', 'server', 'routes', 'admin-console-routes.js'), 'utf8');

  test('usage-forensics requires it and returns all three new arms', () => {
    expect(ROUTE).toContain("require('../services/agent-eval-corpus')");
    for (const call of ['corpusSql()', 'rateByMonthSql()', 'noUsageSplitSql()', 'buildFailureReport(']) {
      expect(ROUTE).toContain(call);
    }
    for (const key of ['failureTaxonomy', 'failureByMonth', 'noUsage:']) {
      expect(ROUTE).toContain(key);
    }
  });
});

// ── mutants ───────────────────────────────────────────────────────────────
let mutantPaths = [];
afterEach(() => {
  for (const p of mutantPaths) {
    try { delete require.cache[require.resolve(p)]; } catch (e) { /* never loaded */ }
    try { fs.unlinkSync(p); } catch (e) { /* already gone */ }
  }
  mutantPaths = [];
});

function mutantCopy(pairs) {
  let out = fs.readFileSync(CORPUS, 'utf8').replace(/\r\n/g, '\n');
  const src = out;
  for (const [find, replace] of pairs) {
    const n = out.split(find).length - 1;
    if (n !== 1) throw new Error('anchor matched ' + n + ' times: ' + find.slice(0, 60));
    out = out.split(find).join(replace);
  }
  if (out === src) throw new Error('MUTATION CHANGED NO BYTES');
  // Unique PER CALL. An index-based name plus a mutantPaths reset in afterEach
  // gives two mutants one path, and jest's module registry is separate from
  // require.cache — so the second require returns the FIRST mutant and the test
  // grades the wrong code while reading as a catch.
  const file = path.join(os.tmpdir(),
    'mutant-corpus-' + process.pid + '-' + Math.random().toString(36).slice(2, 10) + '.js');
  fs.writeFileSync(file, out);
  mutantPaths.push(file);
  return require(file);
}

describe('mutants', () => {
  test('classifying the whole body lets streamed text pick the bucket', () => {
    const broken = mutantCopy([['  const msg = failureMessage(content);', '  const msg = String(content);']]);
    // The partial text has to match an EARLIER bucket than the real message,
    // or match order hides the mutation — my first attempt at this test put
    // 'duplicate key' in the partial text and passed under both versions,
    // because idle_watchdog is tested first and won either way.
    const body = failed(
      'Failed to open session stream',
      'Earlier today 86 stopped responding and this turn was ended after 5 minutes, so I retried.'
    );
    expect(corpus.classifyFailure(body)).toBe('stream_open_failed');
    expect(broken.classifyFailure(body)).toBe('idle_watchdog');
  });

  test('matching the variation selector loses every bare-sign row', () => {
    const broken = mutantCopy([[
      'const WARNING_SIGN = String.fromCharCode(0x26A0);',
      'const WARNING_SIGN = String.fromCharCode(0x26A0) + String.fromCharCode(0xFE0F);',
    ]]);
    const bare = String.fromCharCode(0x26A0) + ' Failed to open session stream';
    expect(corpus.isFailure(bare)).toBe(true);
    expect(broken.isFailure(bare)).toBe(false);
  });

  test('an unmatched failure silently vanishing understates the rate', () => {
    const broken = mutantCopy([['  return OTHER;', '  return NOT_A_FAILURE;']]);
    const unknown = failed('Brand new wording nobody has classified.');
    expect(corpus.classifyFailure(unknown)).toBe('other');
    expect(broken.classifyFailure(unknown)).toBeNull();
    // and the report loses the turn entirely
    expect(broken.buildFailureReport([{ content: unknown, created_at: 'x' }], 10).unclassified_turns).toBe(1);
  });

  test('a zero denominator reported as a rate of 0 is the original bug', () => {
    const broken = mutantCopy([[
      "    failure_pct: (denom && denom > 0) ? Math.round((total / denom) * 10000) / 100 : null,",
      "    failure_pct: (denom && denom > 0) ? Math.round((total / denom) * 10000) / 100 : 0,",
    ]]);
    expect(corpus.buildFailureReport([{ content: failed('x') }], undefined).failure_pct).toBeNull();
    expect(broken.buildFailureReport([{ content: failed('x') }], undefined).failure_pct).toBe(0);
  });
});
