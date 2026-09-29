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
  let cmp;
  let jobCreated;
  beforeAll(() => {
    window.eval(read('js/bt-badge.js'));
    const src = read('js/jobs.js');
    const sources = [extractFunction(src, 'jobCreated'), extractFunction(src, 'jobDateCompare')];
    cmp = compile(sources, ['window'], [window], 'jobDateCompare');
    jobCreated = compile(sources, ['window'], [window], 'jobCreated');
  });

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
    const asc = jobs.slice().sort((a, b) => cmp(a, b, jobCreated, 1)).map((j) => j.id);
    expect(asc).toEqual(['a', 'b', 'c']);
    expect(jobs.slice().sort((a, b) => cmp(a, b, jobCreated, -1)).map((j) => j.id)).toEqual(['c', 'b', 'a']);
    expect(new Set(jobs.map((j) => j.created_at)).size).toBe(1);
  });

  test('a job with no date sorts LAST in BOTH directions', () => {
    // The defect this replaces: an unknown read as 0 and every one of them
    // piled onto the oldest end ascending and the newest end descending.
    const known = { bt_created_at: '2025-01-01T00:00:00Z' };
    const unknown = {};
    expect(cmp(known, unknown, jobCreated, 1)).toBeLessThan(0);
    expect(cmp(unknown, known, jobCreated, 1)).toBeGreaterThan(0);
    expect(cmp(known, unknown, jobCreated, -1)).toBeLessThan(0);
    expect(cmp(unknown, known, jobCreated, -1)).toBeGreaterThan(0);
    expect(cmp(unknown, {}, jobCreated, 1)).toBe(0);
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
