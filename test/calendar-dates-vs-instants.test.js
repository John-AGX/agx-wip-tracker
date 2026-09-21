// EVERY CLIENT DATE HELPER, EXECUTED, AGAINST A COMMITTED CLASSIFICATION.
//
// ── THE TWO BUGS, AND WHY ONE RULE CANNOT COVER BOTH ─────────────────────
// `new Date('2026-09-20')` is parsed as UTC MIDNIGHT. Render that with
// toLocaleDateString(), or read it with .getDate()/.getMonth()/.getFullYear(),
// and every timezone west of Greenwich shows the PREVIOUS day. AGX is in Tampa,
// so a work order due the 20th displayed "Sep 19" — a deadline that appears to
// have already passed. That is BUG A, a day EARLY.
//
// The mirror is just as real. `String(instant).slice(0, 10)` takes the UTC date
// off a genuine timestamp, so 2026-09-08T01:39Z — which is 9:39pm on the 7th in
// Tampa — renders as the 8th. That is BUG B, a day LATE.
//
// So there is no universally correct helper. A DATE column is a CALENDAR DAY
// and must never be shifted into a timezone; a TIMESTAMPTZ is an INSTANT and
// must be. Which is right depends entirely on what reaches the helper, and that
// is a fact about CALL SITES, which no amount of staring at the helper reveals.
//
// ── WHY THIS TEST EXECUTES RATHER THAN READS ─────────────────────────────
// A source-reading assertion ("the file contains a regex") is the failure mode
// this repo keeps rediscovering: it passes while the code is broken. So every
// helper below is lifted out of the shipped file by balanced braces and CALLED,
// the same technique test/receipt-merchant-money-never-summed.test.js uses.
// The timezone is forced, because in UTC the bug is invisible and this suite
// would pass everywhere while users saw the wrong day.
//
// ── HOW IT IS FORCED, AND THE TWO WAYS THE FIRST VERSION DID NOT ─────────
// This file first set process.env.TZ at the top and ran the helpers in the
// jest worker. That does NOTHING: jest hands the test a sandboxed process.env,
// and the worker's zone is fixed when it starts. Measured under jest after the
// assignment: resolved zone still the host's, getTimezoneOffset unchanged. It
// only worked because the machine it ran on is in America/New_York. With the
// jest host forced to UTC it went 18 of 33 red against CORRECT code — the
// instant probes land on the UTC day — so on any other machine it was a broken
// suite rather than a guard.
//
// The todayISO cases had a second hole on top: they compared against the real
// "now", and the UTC day and the Eastern day only differ between 8pm and
// midnight. A reverted todayISO went red in the first mutation run because
// that run happened at 10pm. Re-run at 5:11pm Eastern, the same revert stayed
// GREEN.
//
// So every helper now runs in a CHILD node started with TZ set, with Date
// pinned to 9:30pm Eastern — the hour the two days disagree. A UTC control
// child proves the zone really comes from the environment and not the host.
//
// ── THE LEDGER IS THE POINT ──────────────────────────────────────────────
// The population is DERIVED from disk, never listed. Each helper carries the
// inputs it must get right and the evidence for that claim. A new helper nobody
// classified fails. A ledger entry whose helper is gone fails. A helper that
// stops behaving as recorded fails. Silence is not one of the outcomes.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// 9:30pm on Saturday Sep 19 in New York — 01:30 UTC on Sunday Sep 20. The one
// kind of moment where a UTC-day bug and a correct local day give different
// answers.
const FIXED_NOW = '2026-09-20T01:30:00.000Z';
const FORCED_ZONE = 'America/New_York';

const JS_DIR = path.join(__dirname, '..', 'js');
const HELPER_RE = /function\s+(fmtDate\w*|fmtDay\w*|formatDate\w*|todayISO)\s*\(/g;

// Values a helper is probed with. The two calendar spellings both occur in the
// wild: the bare one from JSONB and <input type="date">, and the T00:00:00.000Z
// one a Postgres DATE column serializes to over JSON.
const CAL_BARE = '2026-09-20';
const CAL_PG = '2026-09-20T00:00:00.000Z';
const INSTANT = '2026-09-08T01:39:32.287Z';   // 9:39pm on Sep 7 in New York

// Helpers a lifted function closes over. Lifted alongside it so it can run.
const CLOSURE_DEPS = ['toLocalDay', 'calDate', 'calDay', 'isoDate', 'isoDay', 'pad', 'fmtDate'];

// ── THE LEDGER ───────────────────────────────────────────────────────────
// cal / pg / inst: must this helper render that input as the correct day?
// `false` is a deliberate, evidenced decision — the helper never receives that
// kind — NOT an admission that it is broken.
const LEDGER = {
  // Reduce "now" to a calendar day for a DATE column. These WRITE, so being
  // wrong stores bad data rather than merely showing it.
  'js/invoices.js:todayISO': { today: true, why: 'defaults issue_date and a payment date; both DATE columns' },
  'js/pay-applications.js:todayISO': { today: true, why: 'fills period_to on a G702 pay application, a DATE column' },
  'js/my-day.js:todayISO': { today: true, why: 'delegates to isoDate, which uses local getters' },
  'js/tasks.js:todayISO': { today: true, why: 'delegates to isoDay, which uses local getters' },
  'js/purchase-order-editor.js:todayISO': { today: true, why: 'stamps a new bill_date (DATE) and the acceptance date on an executed PO and each addendum' },

  // Serve BOTH kinds: they render a mix of DATE columns and timestamps.
  'js/service-tickets.js:fmtDate': { cal: true, pg: true, inst: true, why: 'the reference implementation; renders due_date/scheduled_for (DATE) beside created_at' },
  'js/admin.js:fmtDay': { cal: true, pg: true, inst: true, why: 'materials.last_seen is DATE, users.created_at is TIMESTAMPTZ — one helper, both callers' },
  'js/admin.js:fmtDate': { cal: true, pg: true, inst: true, why: 'compliance expiration_date is DATE; nested helper, shares calDate with daysLeft' },
  'js/compliance-review-ui.js:fmtDate': { cal: true, pg: true, inst: true, why: 'compliance_items.expiration_date is DATE (server/db.js)' },
  'js/job-workflow-ui.js:fmtDate': { cal: true, pg: true, inst: true, why: 'workflow item due_date is DATE; isOverdue in the same file shares toLocalDay' },
  'js/jobs-hub.js:fmtDate': { cal: true, pg: true, inst: true, why: 'renders workflow/bill due_date (DATE) alongside updated_at' },
  'js/leads.js:fmtDate': { cal: true, pg: true, inst: true, why: 'lead grid renders DATE columns and timestamps in the same switch' },
  'js/work-orders-board.js:fmtDate': { cal: true, pg: true, inst: true, why: 'copy of the service-tickets.js reference; renders due_date and scheduled_for (DATE); last crew activity uses fmtAgo' },

  // CALENDAR DAYS ONLY. Slice-style by design: taking the day as written is
  // exactly right, and converting it would introduce Bug A. They mishandle an
  // instant, and that is fine because they never receive one.
  'js/invoices.js:fmtDate': { cal: true, pg: true, inst: false, why: 'issue_date, due_date, payment_date — all DATE (server/db.js:949,950,978)' },
  'js/pay-applications.js:fmtDate': { cal: true, pg: true, inst: false, why: 'period_from/period_to are DATE (server/db.js:914)' },
  'js/cost-inbox.js:fmtDate': { cal: true, pg: true, inst: false, why: 'receipts.purchased_at is DATE; the instants go to fmtDateTime instead' },
  'js/materials-drawer.js:fmtDate': { cal: true, pg: true, inst: false, why: 'materials.last_seen is DATE (server/db.js:2119)' },
  'js/qb-costs-view.js:fmtDate': { cal: true, pg: true, inst: false, why: 'qb_cost_lines.txn_date is DATE (server/db.js:2070)' },
  'js/subs.js:fmtDate': { cal: true, pg: true, inst: false, why: 'subs.w9_expires / insurance_expires are DATE (server/db.js:1762)' },
  'js/service-ticket-field-log.js:fmtDay': { cal: true, pg: true, inst: false, why: 'service_ticket_labor.work_date is DATE (Phase 3 field capture); the server already sends it as YYYY-MM-DD, and the leading-day read also takes the pg ISO form' },
  'js/help-center.js:fmtDate': { cal: true, pg: false, inst: false, why: 'only formats releases[].date, a bare YYYY-MM-DD hand-written in server/feature-catalog.js. Mitigates by appending T12:00:00 — noon local, which no offset can push across a day. pg:false because that concatenation yields an invalid date, which is unreachable here' },

  // INSTANTS ONLY. Converting to the viewer's local time is the correct
  // behaviour; they would mishandle a calendar date and never see one.
  'js/cost-inbox.js:fmtDateTime': { cal: false, pg: false, inst: true, why: 'receipts created_at/updated_at, both TIMESTAMPTZ' },
  'js/report-document.js:fmtDate': { cal: false, pg: false, inst: true, why: 'only photo.shot_at = COALESCE(taken_at, uploaded_at), both TIMESTAMPTZ' },
  'js/estimate-preview.js:fmtDateShort': { cal: false, pg: false, inst: true, why: 'sole call passes a literal new Date() as the "Print Date"; estimates has no DATE column' },
  'js/field-tools.js:fmtDate': { cal: false, pg: false, inst: true, why: 'field_tool_runs / tool created_at, TIMESTAMPTZ' },
  'js/file-explorer.js:fmtDate': { cal: false, pg: false, inst: true, why: 'attachments.uploaded_at, TIMESTAMPTZ' },
  'js/my-files.js:fmtDate': { cal: false, pg: false, inst: true, why: 'attachments.uploaded_at / field_tool_runs.created_at, TIMESTAMPTZ' },
  'js/projects.js:fmtDate': { cal: false, pg: false, inst: true, why: 'photo.uploaded_at, TIMESTAMPTZ' },
  'js/proposal.js:formatDateShort': { cal: false, pg: false, inst: true, why: 'estimates has no DATE column; only timestamps reach it' },
  'js/proposal.js:formatDateLong': { cal: false, pg: false, inst: true, why: 'estimates has no DATE column; only timestamps reach it' },
};

// ── Lifting ──────────────────────────────────────────────────────────────
// Balanced-brace extraction that skips over strings and comments, so a brace
// inside a quoted HTML fragment cannot end the function early.
function lift(src, name, fromIndex) {
  const re = new RegExp('function\\s+' + name + '\\s*\\(', 'g');
  re.lastIndex = fromIndex || 0;
  const m = re.exec(src);
  if (!m) return null;
  const open = src.indexOf('{', m.index);
  if (open < 0) return null;
  let depth = 0;
  let inString = null;
  let inComment = null;
  for (let j = open; j < src.length; j++) {
    const c = src[j];
    const n = src[j + 1];
    if (inComment) {
      if (inComment === '//' && c === '\n') inComment = null;
      else if (inComment === '/*' && c === '*' && n === '/') { inComment = null; j++; }
      continue;
    }
    if (inString) {
      if (c === '\\') { j++; continue; }
      if (c === inString) inString = null;
      continue;
    }
    if (c === '/' && n === '/') { inComment = '//'; j++; continue; }
    if (c === '/' && n === '*') { inComment = '/*'; j++; continue; }
    if (c === '"' || c === "'" || c === '`') { inString = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return { src: src.slice(m.index, j + 1), end: j }; }
  }
  return null;
}

// Derive the population. Never a hand-written list — that is how the first
// sweep of this bug missed thirteen of the twenty-seven helpers.
function discover() {
  const found = [];
  for (const file of fs.readdirSync(JS_DIR).filter((f) => f.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(JS_DIR, file), 'utf8');
    HELPER_RE.lastIndex = 0;
    let m;
    while ((m = HELPER_RE.exec(src))) {
      found.push({ key: 'js/' + file + ':' + m[1], file, name: m[1], at: m.index, src });
    }
  }
  return found;
}

const HELPERS = discover();

// Returns a function BODY that, when run, returns the helper. It is executed in
// the child, never here.
function compileSource(h) {
  const got = lift(h.src, h.name, h.at);
  if (!got) throw new Error('could not lift ' + h.key + ' — the brace scanner failed, which is a test bug, not a pass');

  // Dependencies are collected TRANSITIVELY: tasks.js todayISO calls isoDay,
  // which calls pad. Stopping at one level left pad undefined and the helper
  // threw, which would have read as "cannot check this one" — the outcome this
  // file refuses to have.
  const picked = new Map();
  const queue = [got.src];
  while (queue.length) {
    const body = queue.shift();
    for (const d of CLOSURE_DEPS) {
      if (d === h.name || picked.has(d)) continue;
      if (!new RegExp('\\b' + d + '\\s*\\(').test(body)) continue;
      const dg = lift(h.src, d, 0);
      if (!dg) continue;
      picked.set(d, dg.src);
      queue.push(dg.src);
    }
  }
  const deps = Array.from(picked.values()).join('\n');
  return deps + '\nreturn ' + got.src + ';';
}

// ── The child ────────────────────────────────────────────────────────────
// Passed to `node -e` as its own source text, so nothing here is escaped by
// hand. It reads the payload on stdin, pins Date, runs every helper and both
// predicates, and prints one JSON object.
function childRunner() {
  const payload = JSON.parse(require('fs').readFileSync(0, 'utf8'));
  const RealDate = Date;
  const PINNED = RealDate.parse(payload.fixedNow);
  class PinnedDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(PINNED);
      else super(...args);
    }
    static now() { return PINNED; }
  }
  globalThis.Date = PinnedDate;

  const out = {
    zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    offsetMin: new RealDate(payload.fixedNow).getTimezoneOffset(),
    rawDefect: new RealDate(payload.probes.CAL_BARE).getDate(),
    results: {},
    errors: {},
    predicates: null,
  };
  const call = (fn, arg) => {
    try { return { v: String(fn(arg)) }; } catch (e) { return { err: e.message }; }
  };
  for (const h of payload.helpers) {
    let fn;
    try {
      // eslint-disable-next-line no-new-func
      fn = new Function(h.source)();
    } catch (e) {
      out.errors[h.key] = 'compile: ' + e.message;
      continue;
    }
    out.results[h.key] = h.today
      ? { today: call(fn) }
      : { cal: call(fn, payload.probes.CAL_BARE), pg: call(fn, payload.probes.CAL_PG), inst: call(fn, payload.probes.INSTANT) };
  }
  if (payload.predicates) {
    try {
      // eslint-disable-next-line no-new-func
      const isPastDue = new Function(payload.predicates.isPastDue)();
      // eslint-disable-next-line no-new-func
      const isOverdue = new Function(payload.predicates.isOverdue)();
      const p = (n) => (n < 10 ? '0' : '') + n;
      const shift = (n) => {
        const d = new Date();
        d.setDate(d.getDate() + n);
        return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
      };
      out.predicates = {
        today: shift(0),
        pastDue: { tomorrow: isPastDue(shift(1)), today: isPastDue(shift(0)), yesterday: isPastDue(shift(-1)), none: isPastDue(null) },
        overdue: { todayOpen: isOverdue(shift(0), 'open'), yesterdayOpen: isOverdue(shift(-1), 'open'), yesterdayClosed: isOverdue(shift(-1), 'closed') },
      };
    } catch (e) {
      out.errors.__predicates = e.message;
    }
  }
  process.stdout.write(JSON.stringify(out));
}

function runInZone(tz, payload) {
  const stdout = execFileSync(process.execPath, ['-e', '(' + childRunner.toString() + ')()'], {
    input: JSON.stringify(payload),
    env: Object.assign({}, process.env, { TZ: tz }),
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 60000,
  });
  return JSON.parse(stdout);
}

const PROBES = { CAL_BARE, CAL_PG, INSTANT };
const LIFT_ERRORS = {};
const PAYLOAD_HELPERS = [];
for (const h of HELPERS) {
  const spec = LEDGER[h.key];
  if (!spec) continue;
  try {
    PAYLOAD_HELPERS.push({ key: h.key, today: !!spec.today, source: compileSource(h) });
  } catch (e) {
    LIFT_ERRORS[h.key] = e.message;
  }
}

function predicateSource(file, deps, name) {
  const src = fs.readFileSync(path.join(JS_DIR, file), 'utf8');
  const pieces = deps.map((d) => {
    const got = lift(src, d, 0);
    if (!got) throw new Error('could not lift ' + d + ' from ' + file);
    return got.src;
  });
  const main = lift(src, name, 0);
  if (!main) throw new Error('could not lift ' + name + ' from ' + file);
  return pieces.join('\n') + '\nreturn ' + main.src + ';';
}

// Run once for the whole file. A child that dies throws here, and the suite
// fails loudly with its stderr rather than reporting nothing.
const RUN = runInZone(FORCED_ZONE, {
  fixedNow: FIXED_NOW,
  probes: PROBES,
  helpers: PAYLOAD_HELPERS,
  predicates: {
    isPastDue: predicateSource('invoices.js', [], 'isPastDue'),
    isOverdue: predicateSource('job-workflow-ui.js', ['toLocalDay'], 'isOverdue'),
  },
});
// The control: same code, UTC. If the forced zone were silently ignored and
// the host's zone used instead, these two would agree.
const UTC_CONTROL = runInZone('UTC', { fixedNow: FIXED_NOW, probes: PROBES, helpers: [], predicates: null });

// The day a rendered string claims, whatever its format. Deliberately loose
// about separators, month spelling and zero-padding — a format change must not
// fail this test — and strict about WHICH DAY, which is the whole subject.
function saysDay(out, day) {
  const s = String(out);
  const other = day === 20 ? 19 : 20;
  const has = (d) => new RegExp('(^|\\D)0?' + d + '(\\D|$)').test(s);
  return has(day) && !has(other);
}

describe('calendar days and instants are not the same thing', () => {
  test('the timezone is actually forced — in UTC this whole suite is vacuous', () => {
    // Both bugs are invisible at UTC+0. A suite that silently ran there would
    // stay green while Tampa saw the wrong day, which is the exact failure this
    // file exists to prevent.
    expect(RUN.zone).toBe(FORCED_ZONE);
    expect(RUN.offsetMin).toBe(240);          // EDT at the pinned instant
    expect(RUN.rawDefect).toBe(19);           // the raw defect reproduces there
    // ...and it is the ENVIRONMENT doing it, not whatever zone this machine is in.
    expect(UTC_CONTROL.zone).toBe('UTC');
    expect(UTC_CONTROL.rawDefect).toBe(20);
  });

  test('the pinned clock is an hour where the UTC day and the local day disagree', () => {
    // Without this, every todayISO case is a coin flip on the time of day.
    expect(FIXED_NOW.slice(0, 10)).toBe('2026-09-20');
    expect(RUN.predicates && RUN.predicates.today).toBe('2026-09-19');
  });

  test('every classified helper was lifted and compiled in the child', () => {
    expect(LIFT_ERRORS).toEqual({});
    expect(RUN.errors).toEqual({});
  });

  test('the population is derived from disk, and it is not empty', () => {
    expect(HELPERS.length).toBeGreaterThan(20);
  });

  test('every helper on disk is classified — a new one cannot slip in unjudged', () => {
    const unclassified = HELPERS.map((h) => h.key).filter((k) => !LEDGER[k]);
    // Adding a date helper means deciding what it receives. That decision is
    // cheap when you are writing it and expensive when a client reports a
    // deadline off by one.
    expect(unclassified).toEqual([]);
  });

  test('every ledger entry still names a helper that exists — no stale rows', () => {
    const present = new Set(HELPERS.map((h) => h.key));
    expect(Object.keys(LEDGER).filter((k) => !present.has(k))).toEqual([]);
  });

  test('no file declares two date helpers under one name', () => {
    // js/admin.js did. Duplicate top-level declarations in one function body
    // both hoist and the LAST wins, so a slice helper silently served calls
    // written for another — and a fix applied to the shadowed one could never
    // run. The names now differ (fmtDay vs fmtDate).
    const seen = {};
    const dupes = [];
    for (const h of HELPERS) {
      if (seen[h.key]) dupes.push(h.key);
      seen[h.key] = true;
    }
    expect(dupes).toEqual([]);
  });

  for (const h of HELPERS) {
    const spec = LEDGER[h.key];
    if (!spec) continue;   // already failed above, by name

    if (spec.today) {
      test(h.key + ' returns the LOCAL calendar day (' + spec.why + ')', () => {
        // At the pinned 9:30pm Eastern, toISOString() would say the 20th.
        // These values are written to DATE columns.
        const r = RUN.results[h.key];
        expect(r && r.today).toEqual({ v: '2026-09-19' });
      });
      continue;
    }

    test(h.key + ' handles what it is given (' + spec.why + ')', () => {
      const r = RUN.results[h.key];
      expect(r).toBeTruthy();
      // Asserted as day-claims so a format change does not fail the test but a
      // day change does.
      if (spec.cal) expect({ out: r.cal, day20: saysDay(r.cal.v, 20) }).toEqual({ out: r.cal, day20: true });
      if (spec.pg) expect({ out: r.pg, day20: saysDay(r.pg.v, 20) }).toEqual({ out: r.pg, day20: true });
      if (spec.inst) expect({ out: r.inst, day7: saysDay(r.inst.v, 7) }).toEqual({ out: r.inst, day7: true });
    });
  }

  test('the two predicates that DRIVE styling agree with the day, not the instant', () => {
    // A wrong render is a wrong label. A wrong predicate paints a row red and
    // tells the office a client is late, so these get their own case.
    expect(RUN.predicates).toEqual({
      today: '2026-09-19',
      // due tomorrow / due TODAY is not yet late / due yesterday / no due date
      pastDue: { tomorrow: false, today: false, yesterday: true, none: false },
      overdue: { todayOpen: false, yesterdayOpen: true, yesterdayClosed: false },
    });
  });
});
