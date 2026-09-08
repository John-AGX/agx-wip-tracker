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
// ── THE LEDGER IS THE POINT ──────────────────────────────────────────────
// The population is DERIVED from disk, never listed. Each helper carries the
// inputs it must get right and the evidence for that claim. A new helper nobody
// classified fails. A ledger entry whose helper is gone fails. A helper that
// stops behaving as recorded fails. Silence is not one of the outcomes.
'use strict';

process.env.TZ = 'America/New_York';

const fs = require('fs');
const path = require('path');

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

  // Serve BOTH kinds: they render a mix of DATE columns and timestamps.
  'js/service-tickets.js:fmtDate': { cal: true, pg: true, inst: true, why: 'the reference implementation; renders due_date/scheduled_for (DATE) beside created_at' },
  'js/admin.js:fmtDay': { cal: true, pg: true, inst: true, why: 'materials.last_seen is DATE, users.created_at is TIMESTAMPTZ — one helper, both callers' },
  'js/admin.js:fmtDate': { cal: true, pg: true, inst: true, why: 'compliance expiration_date is DATE; nested helper, shares calDate with daysLeft' },
  'js/compliance-review-ui.js:fmtDate': { cal: true, pg: true, inst: true, why: 'compliance_items.expiration_date is DATE (server/db.js)' },
  'js/job-workflow-ui.js:fmtDate': { cal: true, pg: true, inst: true, why: 'workflow item due_date is DATE; isOverdue in the same file shares toLocalDay' },
  'js/jobs-hub.js:fmtDate': { cal: true, pg: true, inst: true, why: 'renders workflow/bill due_date (DATE) alongside updated_at' },
  'js/leads.js:fmtDate': { cal: true, pg: true, inst: true, why: 'lead grid renders DATE columns and timestamps in the same switch' },

  // CALENDAR DAYS ONLY. Slice-style by design: taking the day as written is
  // exactly right, and converting it would introduce Bug A. They mishandle an
  // instant, and that is fine because they never receive one.
  'js/invoices.js:fmtDate': { cal: true, pg: true, inst: false, why: 'issue_date, due_date, payment_date — all DATE (server/db.js:949,950,978)' },
  'js/pay-applications.js:fmtDate': { cal: true, pg: true, inst: false, why: 'period_from/period_to are DATE (server/db.js:914)' },
  'js/cost-inbox.js:fmtDate': { cal: true, pg: true, inst: false, why: 'receipts.purchased_at is DATE; the instants go to fmtDateTime instead' },
  'js/materials-drawer.js:fmtDate': { cal: true, pg: true, inst: false, why: 'materials.last_seen is DATE (server/db.js:2119)' },
  'js/qb-costs-view.js:fmtDate': { cal: true, pg: true, inst: false, why: 'qb_cost_lines.txn_date is DATE (server/db.js:2070)' },
  'js/subs.js:fmtDate': { cal: true, pg: true, inst: false, why: 'subs.w9_expires / insurance_expires are DATE (server/db.js:1762)' },
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

function compile(h) {
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
  // eslint-disable-next-line no-new-func
  return new Function(deps + '\nreturn ' + got.src + ';')();
}

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
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('America/New_York');
    expect(new Date(CAL_BARE).getDate()).toBe(19);   // the raw defect, still true
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
        const fn = compile(h);
        const now = new Date();
        const p = (n) => (n < 10 ? '0' : '') + n;
        const local = now.getFullYear() + '-' + p(now.getMonth() + 1) + '-' + p(now.getDate());
        // toISOString() would give the UTC day, which after 8pm Eastern is
        // TOMORROW. These values are written to DATE columns.
        expect(fn()).toBe(local);
      });
      continue;
    }

    test(h.key + ' handles what it is given (' + spec.why + ')', () => {
      const fn = compile(h);
      // Asserted as day-claims so a format change does not fail the test but a
      // day change does.
      if (spec.cal) expect(saysDay(fn(CAL_BARE), 20)).toBe(true);
      if (spec.pg) expect(saysDay(fn(CAL_PG), 20)).toBe(true);
      if (spec.inst) expect(saysDay(fn(INSTANT), 7)).toBe(true);
    });
  }

  test('the two predicates that DRIVE styling agree with the day, not the instant', () => {
    // A wrong render is a wrong label. A wrong predicate paints a row red and
    // tells the office a client is late, so these get their own case.
    const invSrc = fs.readFileSync(path.join(JS_DIR, 'invoices.js'), 'utf8');
    const isPastDue = new Function('return ' + lift(invSrc, 'isPastDue', 0).src + ';')();

    const p = (n) => (n < 10 ? '0' : '') + n;
    const shift = (n) => {
      const d = new Date();
      d.setDate(d.getDate() + n);
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    };
    expect(isPastDue(shift(1))).toBe(false);    // due tomorrow
    expect(isPastDue(shift(0))).toBe(false);    // due TODAY is not yet late
    expect(isPastDue(shift(-1))).toBe(true);    // due yesterday
    expect(isPastDue(null)).toBe(false);

    const jwSrc = fs.readFileSync(path.join(JS_DIR, 'job-workflow-ui.js'), 'utf8');
    const toLocalDay = lift(jwSrc, 'toLocalDay', 0).src;
    const isOverdue = new Function(toLocalDay + '\nreturn ' + lift(jwSrc, 'isOverdue', 0).src + ';')();
    expect(isOverdue(shift(0), 'open')).toBe(false);   // due today, not overdue
    expect(isOverdue(shift(-1), 'open')).toBe(true);
    expect(isOverdue(shift(-1), 'closed')).toBe(false);
  });
});
