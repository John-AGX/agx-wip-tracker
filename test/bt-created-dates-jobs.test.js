/**
 * @jest-environment jsdom
 */
/* ──────────────────────────────────────────────────────────────────────────
 * THE JOBS LIST HAD NO DATE COLUMN AT ALL.
 *
 * 687 jobs and no way to ask which are old. The reason it was never added is
 * that the only date available was created_at, and on an imported job that is
 * the instant of the sync: 609 of 687 carried 2026-09-25. A "Created" column
 * built on it would have sorted the list by the order we fetched it.
 *
 * With bt_created_at on the row the column means something, so this covers
 * the two it adds, what they read, how they sort, and the one thing a new
 * cell breaks on a phone.
 * ────────────────────────────────────────────────────────────────────────── */
'use strict';

const fs = require('fs');
const path = require('path');
const { extractFunction, compile } = require('./helpers/browser-fn');
const { liveLine, liveLines } = require('./helpers/live-line');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

describe('the two columns exist and are sortable', () => {
  const html = read('index.html');
  const head = html.slice(html.indexOf('<table id="jobs-table">'), html.indexOf('<tbody></tbody>', html.indexOf('<table id="jobs-table">')));

  test('each has a header, a data-col and a sort handler', () => {
    for (const key of ['created', 'synced']) {
      expect(head).toContain('data-col="' + key + '"');
      expect(head).toContain('data-sort="' + key + '"');
      expect(head).toContain("sortJobsTable('" + key + "')");
    }
  });

  test('the row emits a cell for each, so enhance() can reorder them', () => {
    // table-enhancements.js pairs <th> to <td> by data-col and SKIPS a row
    // without a full set. A header with no cell silently disables reordering
    // for the whole table rather than erroring.
    const src = read('js/jobs.js');
    for (const key of ['created', 'synced']) {
      expect(src).toContain('<td data-col="' + key + '"');
    }
  });

  test('each has a default width', () => {
    const src = read('js/table-enhancements.js');
    const jobs = src.slice(src.indexOf('jobs: {'), src.indexOf('estimates: {'));
    expect(jobs).toContain('created: 110');
    expect(jobs).toContain('synced: 110');
  });
});

describe('what the cells read', () => {
  let jobCreated, jobSynced;
  beforeAll(() => {
    window.eval(read('js/bt-badge.js'));
    const src = read('js/jobs.js');
    const sources = [extractFunction(src, 'jobCreated'), extractFunction(src, 'jobSynced')];
    jobCreated = compile(sources, ['window'], [window], 'jobCreated');
    jobSynced = compile(sources, ['window'], [window], 'jobSynced');
  });

  test('Buildertrend’s date wins over the date of the sync', () => {
    expect(jobCreated({ bt_job_id: '1', bt_created_at: '2025-02-01T18:05:21Z', created_at: '2026-09-25T12:13:34Z' }))
      .toBe('2025-02-01T18:05:21Z');
  });

  test('a job made in Project 86 keeps its own date', () => {
    expect(jobCreated({ created_at: '2026-03-04T00:00:00Z' })).toBe('2026-03-04T00:00:00Z');
  });

  test('a job synced before the columns existed still shows a date', () => {
    expect(jobCreated({ bt_job_id: '1', created_at: '2026-09-25T12:13:34Z' })).toBe('2026-09-25T12:13:34Z');
  });

  test('Synced is null when nothing was ever synced, not the creation date', () => {
    expect(jobSynced({ created_at: '2026-03-04T00:00:00Z' })).toBeNull();
    expect(jobSynced({ bt_synced_at: '2026-09-25T12:00:00Z' })).toBe('2026-09-25T12:00:00Z');
  });
});

describe('how the two columns sort', () => {
  // The comparison moved into js/jobs-sort.js — the one sort behind the
  // header, the toolbar select and the phone cards — and jobDateCompare went
  // with it. These are its assertions, unchanged, run through that module
  // with the SAME jobCreated the Created cell reads.
  let S;
  let jobCreated;
  beforeAll(() => {
    window.eval(read('js/bt-badge.js'));
    window.eval(read('js/jobs-sort.js'));
    S = window.p86JobsSort;
    const src = read('js/jobs.js');
    jobCreated = compile([extractFunction(src, 'jobCreated')], ['window'], [window], 'jobCreated');
  });
  const order = (jobs, id) => S.sort(jobs, id, { created: jobCreated }).map((j) => j.id);

  test('imported jobs spread out instead of clumping on the import date', () => {
    // Three jobs from one sync. On created_at they are one instant apart at
    // most and the order is meaningless; on Buildertrend’s date they are a
    // year and a half apart.
    const synced = '2026-09-25T12:13:34Z';
    const jobs = [
      { id: 'c', bt_created_at: '2026-01-10T00:00:00Z', created_at: synced },
      { id: 'a', bt_created_at: '2024-12-12T13:09:42Z', created_at: synced },
      { id: 'b', bt_created_at: '2025-06-02T00:00:00Z', created_at: synced },
    ];
    expect(order(jobs, 'created-asc')).toEqual(['a', 'b', 'c']);
    expect(order(jobs, 'created-desc')).toEqual(['c', 'b', 'a']);
    expect(new Set(jobs.map((j) => j.created_at)).size).toBe(1);
  });

  test('a job with no date sorts LAST in BOTH directions', () => {
    // The defect this replaces: an unknown read as 0 and every one of them
    // piled onto the oldest end ascending and the newest end descending.
    const jobs = [{ id: 'unknown' }, { id: 'known', bt_created_at: '2025-01-01T00:00:00Z' }];
    expect(order(jobs, 'created-asc')).toEqual(['known', 'unknown']);
    expect(order(jobs, 'created-desc')).toEqual(['known', 'unknown']);
  });

  test('the Created header and "Newest first" in the select are the same sort', () => {
    expect(S.headerNext('name-asc', 'created')).toBe('created-desc');
    expect(S.spec('created-desc').label).toBe('Newest first');
    expect(S.headerMark('created-desc')).toEqual({ th: 'created', dir: 'desc' });
  });
});

describe('the phone card', () => {
  test('hides both, because a cell with no order lands above the job name', () => {
    // Every cell on the card is placed by an explicit `order`; the default is
    // 0, which is ahead of the job name at 10. A new column that only added a
    // <td> would have rewritten the card that shipped in 1.70.
    // The repo is CRLF, so a needle anchored on \n finds nothing and
    // slice(-1) then hands back the last character of the file — a test that
    // passes vacuously in both directions. Normalise before looking.
    const css = read('css/styles.css').replace(/\r\n/g, '\n');
    const start = css.indexOf('@media (max-width: 640px) {\n  #jobs-table {');
    expect(start).toBeGreaterThan(-1);
    const phone = css.slice(start);
    const at = phone.indexOf('#jobs-table td[data-col="created"]');
    expect(at).toBeGreaterThan(-1);
    expect(phone.slice(at, at + 160)).toContain('display: none !important');
    expect(phone.slice(at, at + 160)).toContain('#jobs-table td[data-col="synced"]');
    // and nothing gave either of them an order, which would contradict that
    for (const key of ['created', 'synced']) {
      const orderAt = phone.indexOf('#jobs-table td[data-col="' + key + '"] { order:');
      expect(orderAt).toBe(-1);
    }
  });
});

describe('the two dates reach the client at all', () => {
  const src = read('server/routes/job-routes.js');
  const list = src.slice(src.indexOf("router.get('/', requireAuth"), src.indexOf("res.json({ jobs: result })"));

  test('the list selects and returns them', () => {
    expect(liveLine(list, 'j.bt_created_at, j.bt_synced_at,')).toBe(true);
    for (const frag of ['bt_created_at: j.bt_created_at || null',
      'bt_synced_at: j.bt_synced_at || null',
      'created_at: j.created_at || null']) {
      expect(liveLines(list, frag).length).toBe(1);
    }
  });

  test('they are read off the COLUMN, never the blob', () => {
    // The spread of j.data comes FIRST, so a copy that crept into the JSONB
    // cannot shadow the column — same rule as bt_job_id beside it.
    const spread = list.indexOf('...j.data');
    expect(spread).toBeGreaterThan(-1);
    expect(list.indexOf('bt_created_at: j.bt_created_at')).toBeGreaterThan(spread);
  });

  test('a bulk save cannot round-trip them back into the blob', () => {
    // They ride OUT on the GET, so without this they ride back IN on the next
    // save and a client could set any of the three to anything it liked.
    //
    // liveLine, not toContain: a commented-out `delete` still contains the
    // text. Mutation-checked — toContain passed with the line disabled.
    for (const key of ['bt_created_at', 'bt_synced_at', 'created_at']) {
      expect(liveLine(src, 'delete jobBlob.' + key + ';')).toBe(true);
    }
  });

  test('the leads list needs no such change — it selects l.*', () => {
    const leads = read('server/routes/lead-routes.js');
    expect(leads).toContain('l.*,');
    // and bt_* is not in the editable allowlist, so a PUT cannot set it
    const allow = leads.slice(leads.indexOf('const EDITABLE_FIELDS = ['), leads.indexOf('];', leads.indexOf('const EDITABLE_FIELDS = [')));
    expect(allow).not.toContain('bt_');
  });
});

describe('a new column has to reach the people who already use the list', () => {
  /* THREE LAYERS, EACH OUT-RANKING THE LAST.
   *
   * The registry (LEAD_COLS), the set saved in localStorage, and a saved VIEW
   * that replaces that set wholesale on every page load. Adding Synced to the
   * registry reached nobody. A one-time upgrade of the saved set ALSO reached
   * nobody, because leadsLoadViews() applies the default view immediately
   * afterwards and writes the view's own columns over it — checked on the
   * live list both times: the flag was set and the column was not there.
   */
  const src = read('js/leads.js').replace(/\r\n/g, '\n');
  let withSyncedCol;
  let rememberSyncedChoice;

  beforeEach(() => {
    window.localStorage.clear();
    const sources = ['var SYNC_OFF = ' + JSON.stringify('p86-leads-cols-syncoff') + ';',
      extractFunction(src, 'syncedColOff'),
      extractFunction(src, 'withSyncedCol'),
      extractFunction(src, 'rememberSyncedChoice')];
    withSyncedCol = compile(sources, ['localStorage'], [window.localStorage], 'withSyncedCol');
    rememberSyncedChoice = compile(sources, ['localStorage'], [window.localStorage], 'rememberSyncedChoice');
  });

  test('it rides next to Created', () => {
    expect(withSyncedCol(['title', 'created_at', 'updated_at']))
      .toEqual(['title', 'created_at', 'bt_synced_at', 'updated_at']);
  });

  test('it is never added where Created is not shown', () => {
    // Synced answers a question about a date that is already on screen.
    expect(withSyncedCol(['title', 'status', 'updated_at'])).toEqual(['title', 'status', 'updated_at']);
  });

  test('it is never added twice', () => {
    const once = ['created_at', 'bt_synced_at'];
    expect(withSyncedCol(once)).toEqual(once);
  });

  test('switching it off in the picker sticks, and is not a one-way door', () => {
    // A set the person chose that keeps Created and drops Synced is them
    // saying no. Without recording that, the next page load puts it back and
    // they can never get rid of it.
    rememberSyncedChoice(['title', 'created_at']);
    expect(withSyncedCol(['title', 'created_at'])).toEqual(['title', 'created_at']);
    // and ticking it on again forgets the refusal
    rememberSyncedChoice(['title', 'created_at', 'bt_synced_at']);
    expect(withSyncedCol(['title', 'created_at'])).toEqual(['title', 'created_at', 'bt_synced_at']);
  });

  test('a set with no Created column says nothing either way', () => {
    // Otherwise "Reset columns" (the defaults carry no Created) would read as
    // a refusal and silently switch the column off for ever.
    rememberSyncedChoice(['title', 'created_at']);          // a real refusal
    window.localStorage.clear();
    rememberSyncedChoice(['title', 'status']);              // says nothing
    expect(withSyncedCol(['title', 'created_at'])).toEqual(['title', 'created_at', 'bt_synced_at']);
  });

  test('a browser that refuses localStorage still renders the list', () => {
    // Private windows throw out of getItem. The column is worth less than the
    // page, so the accessor is wrapped and the default is "show it".
    const boom = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
    const sources = ['var SYNC_OFF = "p86-leads-cols-syncoff";',
      extractFunction(src, 'syncedColOff'), extractFunction(src, 'withSyncedCol'), extractFunction(src, 'rememberSyncedChoice')];
    const w = compile(sources, ['localStorage'], [boom], 'withSyncedCol');
    const r = compile(sources, ['localStorage'], [boom], 'rememberSyncedChoice');
    expect(w(['created_at'])).toEqual(['created_at', 'bt_synced_at']);
    expect(() => r(['created_at'])).not.toThrow();
  });

  test('BOTH places the column set comes from run it', () => {
    // restoreLeadCols alone is not enough: applyLeadsView overwrites what it
    // produced, on every load, for anyone with a default view. That is the
    // bug this replaces, and a test that only looked at restoreLeadCols would
    // have passed straight through it.
    const restore = src.slice(src.indexOf('function restoreLeadCols()'), src.indexOf('var _isTerminalLead'));
    expect(liveLine(restore, '_leadCols = withSyncedCol(_leadCols);')).toBe(true);
    const view = src.slice(src.indexOf('function applyLeadsView(v)'), src.indexOf('window.leadsOpenViews'));
    expect(liveLines(view, 'withSyncedCol(cfg.columns.slice())').length).toBe(1);
  });

  test('the picker records the choice on every path that sets the columns', () => {
    const picker = src.slice(src.indexOf("pop.querySelectorAll('.lc-box')"), src.indexOf('#leads-save-view'));
    // the per-checkbox handler and "All"
    expect(liveLines(picker, 'rememberSyncedChoice(set);').length).toBe(1);
    expect(liveLines(picker, 'rememberSyncedChoice(_leadCols);').length).toBe(1);
    // and "Reset" clears it rather than recording a refusal
    expect(liveLines(picker, 'localStorage.removeItem(SYNC_OFF);').length).toBe(1);
  });

  test('it is in the registry and in no default', () => {
    const cols = src.slice(src.indexOf('var LEAD_COLS'), src.indexOf('var LEADS_DEFAULT_COLS'));
    expect(cols).toContain("{ key: 'bt_synced_at', label: 'Synced', sort: true }");
    const defaults = src.slice(src.indexOf('var LEADS_DEFAULT_COLS = '), src.indexOf('\n', src.indexOf('var LEADS_DEFAULT_COLS = ')));
    expect(defaults).not.toContain('bt_synced_at');
  });
});

describe('the four record types that hang off a job', () => {
  /* THE SAME DATE, FOUR MORE TIMES, dropped at a different layer in each.
   *
   * Change orders and purchase orders lost it at the READER (allowlisted for
   * the dataset, never named in readChangeOrder/readPurchaseOrder). Estimates
   * lost it one layer later, in btSide — the enumerated worksheet view, the
   * same shape that dropped the job's date. Bills were already carrying it all
   * the way to the wire and only wanted a column to land in.
   */
  const fieldMap = require('../server/services/clickr/field-map');

  test('layer 1: each reader names the key ITS dataset sends', () => {
    // Buildertrend does not use one name, and a reader that names the wrong
    // one reads undefined and says nothing about it.
    expect(fieldMap.readChangeOrder({ changeOrderId: '1', dateAdded: '2026-03-01T10:00:00' }).dateAdded)
      .toBe('2026-03-01T10:00:00');
    expect(fieldMap.readPurchaseOrder({ purchaseOrderId: '1', dateAdded: '2026-03-01T10:00:00' }).dateAdded)
      .toBe('2026-03-01T10:00:00');
    expect(fieldMap.readBill({ billId: '1', createdDate: '2026-03-01T10:00:00' }).createdDate)
      .toBe('2026-03-01T10:00:00');
    expect(fieldMap.readEstimateLine({ worksheetId: '1', dateAdded: '2026-03-01T10:00:00' }).dateAdded)
      .toBe('2026-03-01T10:00:00');
  });

  test('the key is chosen in ONE place, not guessed per call site', () => {
    // Six kinds, two names. Naming a key at each of the six call sites is how
    // one of them ends up reading undefined for ever without a word.
    //
    // That one place is now bt-match.js, because the PREVIEW has to read the
    // same key to say which records are still owed a date (match.btCreatedDue,
    // counted by the safe button). Two readers, one rule: a count that could
    // drift from the write would put a number on a button that does not come
    // down when it is pressed. sync-apply holds the alias and nothing else.
    const src = read('server/services/clickr/sync-apply.js').replace(/\r\n/g, '\n');
    const match = read('server/services/clickr/bt-match.js').replace(/\r\n/g, '\n');
    expect(liveLine(match, 'function btCreatedRaw(bt) {')).toBe(true);
    expect(liveLine(src, 'const btCreatedRaw = match.btCreatedRaw;')).toBe(true);
    expect(liveLine(src, 'function btCreatedRaw(bt) {')).toBe(false);
    const calls = src.match(/healBtDates(Loose)?\(db, '[a-z_]+', orgId, [a-z.]+, row\.bt\)/g) || [];
    expect(calls.length).toBe(6);
    // and nothing hands it a single named key instead of the whole bt side
    expect(src).not.toContain('row.bt.createdDate)');
    expect(src).not.toContain('row.bt.dateAdded)');
  });

  test('it is only ever pointed at tables this file names itself', () => {
    // The table name is interpolated into the SQL, so it must never come from
    // a record.
    const src = read('server/services/clickr/sync-apply.js');
    const tables = (src.match(/healBtDates(?:Loose)?\(db, '([a-z_]+)'/g) || [])
      .map((c) => c.split("'")[1]);
    expect(new Set(tables)).toEqual(new Set(['jobs', 'leads', 'job_change_orders',
      'job_purchase_orders', 'job_vendor_bills', 'estimates']));
  });

  test('the columns exist on all six tables', () => {
    const db = read('server/db.js');
    for (const t of ['jobs', 'leads', 'job_change_orders', 'job_purchase_orders',
      'job_vendor_bills', 'estimates']) {
      expect(db).toMatch(new RegExp('ALTER TABLE ' + t + '\\s+ADD COLUMN IF NOT EXISTS bt_created_at TIMESTAMPTZ;'));
      expect(db).toMatch(new RegExp('ALTER TABLE ' + t + '\\s+ADD COLUMN IF NOT EXISTS bt_synced_at\\s+TIMESTAMPTZ;'));
    }
  });

  test('EVERY door that hands out the Buildertrend link hands out its dates', () => {
    // Not "at least one select has them": these routes each have several, and
    // a door that carries the link but not the dates renders a record as
    // synced while showing the date we imported it. Found by mutation — the
    // first version of this test asserted "more than none" and a select could
    // lose them in silence.
    //
    // The rule is per SELECT: wherever bt_<kind>_id is read off the row, both
    // dates are read beside it.
    for (const [file, idCol] of [
      ['server/routes/change-order-routes.js', 'bt_co_id'],
      ['server/routes/purchase-order-routes.js', 'bt_po_id'],
      ['server/routes/bill-routes.js', 'bt_bill_id'],
      ['server/routes/estimate-routes.js', 'bt_worksheet_id'],
    ]) {
      // Comments are stripped first: the word SELECT appears in the prose
      // beside these columns, and a comment is not a door. Then any
      // `${NAME}` column list is inlined from the const it names — bills keep
      // theirs in SELECT_COLS, and without this their every door reads as
      // carrying no columns at all and the check passes vacuously.
      let src = read(file).replace(/\r\n/g, '\n')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
      for (const [, name] of src.matchAll(/\$\{([A-Z_]+)\}/g)) {
        const m = src.match(new RegExp('const ' + name + ' = `([^`]*)`'));
        if (m) src = src.split('${' + name + '}').join(m[1]);
      }
      const selects = src.split(/\bSELECT\b/).slice(1)
        .map((chunk) => chunk.split(/\bFROM\b/)[0])
        .filter((cols) => new RegExp('\\b' + idCol + '\\b').test(cols));
      expect(selects.length).toBeGreaterThan(0);
      for (const cols of selects) {
        expect([file, idCol, /\bbt_created_at\b/.test(cols), /\bbt_synced_at\b/.test(cols)])
          .toEqual([file, idCol, true, true]);
      }
      // and the row shape hands them to the client, exactly once
      expect(liveLines(src, 'bt_created_at: r.bt_created_at').length).toBe(1);
      expect(liveLines(src, 'bt_synced_at: r.bt_synced_at').length).toBe(1);
    }
  });

  test('none of them can round-trip back into a data blob', () => {
    // They ride OUT on every read, so without this they ride back IN on the
    // next save and sit in the blob shadowing nothing and growing.
    // Exact counts, not "more than none": job-financials.js holds BOTH the
    // change-order and the purchase-order cleaner, so one of them could lose
    // the line without the other noticing. Mutation-checked.
    const fin = read('server/services/job-financials.js').replace(/\r\n/g, '\n');
    expect(liveLines(fin, "'bt_created_at', 'bt_synced_at',").length).toBe(2);
    const bills = read('server/routes/bill-routes.js').replace(/\r\n/g, '\n');
    expect(liveLines(bills, "'bt_created_at', 'bt_synced_at',").length).toBe(1);
    const est = read('server/routes/estimate-routes.js').replace(/\r\n/g, '\n');
    expect(liveLine(est, 'delete blob.bt_created_at;')).toBe(true);
    expect(liveLine(est, 'delete blob.bt_synced_at;')).toBe(true);
  });

  test('all three jobs-hub lists print it, through ONE cell', () => {
    // Three tables, one createdCell — a fourth copy is how two of them end up
    // reading different keys.
    const src = read('js/jobs-hub.js').replace(/\r\n/g, '\n');
    expect(liveLine(src, 'function createdCell(r) {')).toBe(true);
    expect(liveLines(src, 'createdCell(r) +').length).toBe(3);
    expect((src.match(/<th data-col="created">Created<\/th>/g) || []).length).toBe(3);
  });

  test('the estimates list prints it AND sorts on it', () => {
    const src = read('js/estimates.js').replace(/\r\n/g, '\n');
    expect(liveLines(src, "estimatesHeaderCell('Created',       'created_at')").length).toBe(1);
    expect(liveLines(src, 'data-col="created_at"').length).toBe(1);
    expect(liveLines(src, "else if (key === 'created_at') {").length).toBe(1);
    // an unknown date sorts LAST in both directions, not as 0
    const cmp = src.slice(src.indexOf("else if (key === 'created_at') {"));
    expect(cmp.slice(0, 700)).toContain('if (ac == null) return 1;');
    expect(cmp.slice(0, 700)).toContain('if (bc == null) return -1;');
    // and it defaults to newest-first like the other two dates
    expect(src).toContain("key === 'sent_at' || key === 'created_at' || key === 'status'");
  });
});

describe('the column, the sort, the filter and the export all mean the same date', () => {
  /* A LIST THAT SHOWS ONE DATE AND FILTERS ANOTHER IS WORSE THAN NO COLUMN.
   *
   * Created moved to Buildertrend's date on the leads and estimates lists, but
   * the date-range FILTER and the Excel EXPORT still read the raw created_at.
   * On the live org 911 of 1,062 leads and 55 of 108 estimates carry the import
   * day there — so filtering Created to 2024 returned nothing while the visible
   * column was full of 2024, "last 30 days" returned every imported record, and
   * the spreadsheet's Created column disagreed with the screen's on every row.
   */
  test('leads: the filter reads the same accessor the cell does', () => {
    const src = read('js/leads.js').replace(/\r\n/g, '\n');
    expect(liveLines(src, 'leadDateInRange(leadCreated(l), FD.resolveDateRange(d.created_at))').length).toBe(1);
    // and nothing still filters Created on the raw column
    expect(liveLines(src, 'leadDateInRange(l.created_at,').length).toBe(0);
  });

  test('leads: the export prints the same date, and Synced as a day not an instant', () => {
    const src = read('js/leads.js').replace(/\r\n/g, '\n');
    expect(liveLines(src, "case 'created_at': { var lc = leadCreated(l);").length).toBe(1);
    expect(liveLines(src, "case 'bt_synced_at': { var ls = leadSynced(l);").length).toBe(1);
    // created_at must no longer fall through the shared raw-column case
    const shared = src.match(/case 'projected_sale_date':[^\n]*\n/);
    expect(shared).toBeTruthy();
    expect(shared[0]).not.toContain("case 'created_at'");
  });

  test('estimates: the filter and the export read the column accessor', () => {
    const src = read('js/estimates.js').replace(/\r\n/g, '\n');
    expect(liveLines(src, 'estDateInRange(estCreated(e) || e.created_at, FD.resolveDateRange(d.created_at))').length).toBe(1);
    expect(liveLines(src, 'estDateInRange(e.created_at,').length).toBe(0);
    expect(liveLines(src, 'var ec = estCreated(e) || e.created_at;').length).toBe(1);
    // the raw column must no longer be what the sheet prints for Created
    expect(liveLines(src, "e.created_at ? String(e.created_at).slice(0, 10) : ''").length).toBe(0);
  });
});
