/* ── Jobs list sort ─────────────────────────────────────────────────────
   ONE sort for the Jobs list, shared by the toolbar select (the only way to
   sort on a phone, where the table header is hidden), the desktop header
   chevrons and the phone cards. Pure: js/jobs.js hands it the jobs and the
   derived values it cannot compute itself (WIP money, the owner's name, the
   market name, the Created and Synced instants), so it is tested directly
   (test/jobs-sort.test.js).

   A sort is an id, "<key>-<dir>". The select lists the MENU ids; a header
   click can reach the rest (client, PM, market, profit, Synced, the reversed
   money sorts), and the select then shows that one too, so it never names a
   sort the list is not in.

   Why each key is what it is:
   - created: the Created column's own instant (js/jobs.js jobCreated →
     p86BtBadge.createdInstant: Buildertrend's date for a job that came from
     there, the row's created_at for one made here). "Newest first" is the
     same order as clicking that column.
   - name: the job's title. The "Job # / Name" header sorts by NUMBER, which
     is what it always did and what the cell leads with.
   - number: numeric collation, so RV999 sorts before RV2044.
   - status: lifecycle order (New → Archived), not alphabetical.
   - pctcomplete, pm: the values the row DISPLAYS (WIP % and the owner's
     name). The old sort read stored copies that can disagree with them.
   A missing value sorts LAST in both directions, and ties fall back to job #
   then id: the server returns jobs in heap order, so an unbroken tie could
   reshuffle between reloads. */
(function (root) {
  'use strict';

  var STORAGE_KEY = 'p86_jobs_sort';
  var DEFAULT_ID = 'created-desc';
  var STATUS_ORDER = ['New', 'Backlog', 'In Progress', 'On Hold', 'Warranty', 'Completed', 'Archived'];

  // type: how values compare. first: the direction a header click starts in
  // (text ascending, money and dates descending — the Leads/Estimates rule).
  // th: the header whose chevron shows this sort (null: no column for it).
  var KEYS = {
    created:     { type: 'num',   first: 'desc', th: 'created' },
    synced:      { type: 'num',   first: 'desc', th: 'synced' },
    name:        { type: 'text',  first: 'asc',  th: 'name' },
    number:      { type: 'text',  first: 'asc',  th: 'name' },
    client:      { type: 'text',  first: 'asc',  th: 'client' },
    pm:          { type: 'text',  first: 'asc',  th: 'pm' },
    status:      { type: 'num',   first: 'asc',  th: 'status' },
    btstatus:    { type: 'num',   first: 'asc',  th: null },
    market:      { type: 'text',  first: 'asc',  th: 'market' },
    start:       { type: 'plain', first: 'desc', th: null },
    contract:    { type: 'num',   first: 'desc', th: 'contract' },
    pctcomplete: { type: 'num',   first: 'desc', th: 'pctcomplete' },
    profit:      { type: 'num',   first: 'desc', th: 'profit' },
    margin:      { type: 'num',   first: 'desc', th: 'margin' }
  };
  // A header's data-sort -> the key it sorts by.
  var HEADER_KEY = {
    name: 'number', client: 'client', pm: 'pm', status: 'status', market: 'market',
    contract: 'contract', pctcomplete: 'pctcomplete', profit: 'profit', margin: 'margin',
    created: 'created', synced: 'synced'
  };

  var SORTS = [
    { id: 'created-desc', label: 'Newest first', menu: true },
    { id: 'created-asc', label: 'Oldest first', menu: true },
    { id: 'name-asc', label: 'Name A–Z', menu: true },
    { id: 'name-desc', label: 'Name Z–A', menu: true },
    { id: 'number-asc', label: 'Job number', menu: true },
    { id: 'number-desc', label: 'Job number, reversed' },
    { id: 'start-desc', label: 'Start date, latest first', menu: true },
    { id: 'start-asc', label: 'Start date, earliest first', menu: true },
    { id: 'status-asc', label: 'Status', menu: true },
    { id: 'status-desc', label: 'Status, reversed' },
    // Buildertrend's OWN word, not P86's. The two disagree on purpose — a job
    // Open in Buildertrend can be On Hold here — so this is its own sort, and
    // picking it answers "what is still open over there" in one click.
    { id: 'btstatus-asc', label: 'Buildertrend: Open first', menu: true },
    { id: 'btstatus-desc', label: 'Buildertrend: Open last' },
    { id: 'contract-desc', label: 'Income, high to low', menu: true },
    { id: 'contract-asc', label: 'Income, low to high' },
    { id: 'pctcomplete-desc', label: '% complete, high to low', menu: true },
    { id: 'pctcomplete-asc', label: '% complete, low to high' },
    { id: 'margin-desc', label: 'Margin, high to low', menu: true },
    { id: 'margin-asc', label: 'Margin, low to high' },
    { id: 'profit-desc', label: 'Profit, high to low' },
    { id: 'profit-asc', label: 'Profit, low to high' },
    { id: 'synced-desc', label: 'Synced, newest first' },
    { id: 'synced-asc', label: 'Synced, oldest first' },
    { id: 'client-asc', label: 'Client A–Z' },
    { id: 'client-desc', label: 'Client Z–A' },
    { id: 'pm-asc', label: 'PM A–Z' },
    { id: 'pm-desc', label: 'PM Z–A' },
    { id: 'market-asc', label: 'Market A–Z' },
    { id: 'market-desc', label: 'Market Z–A' }
  ];
  var BY_ID = {};
  SORTS.forEach(function (s) {
    var p = s.id.split('-');
    s.key = p[0];
    s.dir = p[1];
    BY_ID[s.id] = s;
  });

  function valid(id) { return typeof id === 'string' && Object.prototype.hasOwnProperty.call(BY_ID, id); }
  function spec(id) { return BY_ID[valid(id) ? id : DEFAULT_ID]; }

  // The select's options: the menu, plus the current sort when a header click
  // put the list in one the menu does not carry.
  function menuFor(id) {
    var cur = spec(id);
    var list = SORTS.filter(function (s) { return s.menu; });
    return cur.menu ? list : list.concat([cur]);
  }

  // Two-state header click: the column whose chevron is showing flips, a new
  // one starts in its natural direction. There is no "off" — off was the
  // server's heap order. "The column whose chevron is showing" matters for
  // Job # / Name, which carries two sorts: a Name sort chosen in the select
  // shows its chevron there, and clicking it must reverse the NAME sort, not
  // silently swap to job number under an unmoved chevron.
  function headerNext(currentId, col) {
    var key = HEADER_KEY[col];
    var cur = spec(currentId);
    if (!key) return cur.id;
    if (KEYS[cur.key].th === col) return cur.key + '-' + (cur.dir === 'asc' ? 'desc' : 'asc');
    return key + '-' + KEYS[key].first;
  }

  function headerMark(id) {
    var s = spec(id);
    var th = KEYS[s.key].th;
    return th ? { th: th, dir: s.dir } : null;
  }

  // ── values ────────────────────────────────────────────────────────
  // An instant as epoch ms, or null — never 1970 for "unknown" (the same rule
  // as p86BtBadge.createdSortKey).
  function instant(v) {
    if (v == null || v === '') return null;
    var t = Date.parse(String(v));
    return isFinite(t) ? t : null;
  }
  function text(v) { var s = String(v == null ? '' : v).trim(); return s || null; }
  function num(v) {
    if (v == null || v === '') return null;
    var n = Number(v);
    return isFinite(n) ? n : null;
  }
  // A calendar day, compared as its 'YYYY-MM-DD' text — never through Date,
  // which would shift it across a timezone.
  function dayKey(v) {
    var m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v == null ? '' : v).trim());
    return m ? m[1] : null;
  }
  // ── what Buildertrend says ────────────────────────────────────────
  // The sync writes Buildertrend's own word onto the job as data.btStatus,
  // which reaches the client flattened onto the job. ONE reader, because the
  // Jobs list filters on the same word the sort ranks by — two spellings of
  // "open" would mean the filter and the sort disagree about the same job.
  var BT_ORDER = ['open', 'warranty', 'closed'];
  function btWord(job) { return String((job && job.btStatus) || '').trim().toLowerCase(); }
  // Open first, then warranty, then closed, then any word Buildertrend adds
  // later. A job Buildertrend has never heard of ranks null, and null sorts
  // LAST in both directions — "Open last" must not mean "jobs that are not in
  // Buildertrend at all, first".
  function btRank(job) {
    var w = btWord(job);
    if (!w) return null;
    var i = BT_ORDER.indexOf(w);
    return i < 0 ? BT_ORDER.length : i;
  }

  function titleOf(j) { return j.title || j.job_title || j.jobName || j.name || ''; }
  function numberOf(j) { return j.jobNumber || j.job_number || ''; }

  function keyOf(job, key, ctx) {
    var w;
    switch (key) {
      case 'created': return instant(ctx.created ? ctx.created(job) : job.created_at);
      case 'synced': return instant(ctx.synced ? ctx.synced(job) : job.bt_synced_at);
      case 'name': return text(titleOf(job));
      case 'number': return text(numberOf(job));
      case 'client': return text(job.client);
      case 'pm': return text(ctx.owner ? ctx.owner(job) : job.pm);
      case 'market': return text(ctx.market ? ctx.market(job) : job.market);
      case 'status': {
        var s = text(job.status);
        if (s == null) return null;
        var i = STATUS_ORDER.indexOf(s);
        return i < 0 ? STATUS_ORDER.length : i;
      }
      case 'btstatus': return btRank(job);
      case 'start': return dayKey(job.startDate);
      case 'contract': w = ctx.wip ? ctx.wip(job) : {}; return num(w && w.totalIncome);
      case 'pctcomplete': w = ctx.wip ? ctx.wip(job) : {}; return num(w && w.pctComplete);
      case 'profit': w = ctx.wip ? ctx.wip(job) : {}; return num(w && w.displayProfit);
      case 'margin': w = ctx.wip ? ctx.wip(job) : {}; return num(w && w.displayMargin);
      default: return null;
    }
  }

  // ── compare ───────────────────────────────────────────────────────
  var COLL = (typeof Intl !== 'undefined' && Intl.Collator)
    ? new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }) : null;
  function cmpText(a, b) {
    if (COLL) return COLL.compare(a, b);
    a = a.toLowerCase(); b = b.toLowerCase();
    return a < b ? -1 : a > b ? 1 : 0;
  }
  function cmpPlain(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

  // A NEW array in sort order; `jobs` is not touched. Each key is computed
  // once per job (decorate-sort-undecorate) — the money keys cost a full WIP
  // computation, and the list re-renders on every background money repaint.
  function sortJobs(jobs, id, ctx) {
    ctx = ctx || {};
    var s = spec(id);
    var cmp = KEYS[s.key].type === 'text' ? cmpText : cmpPlain;
    var flip = s.dir === 'desc' ? -1 : 1;
    var rows = (jobs || []).map(function (j) {
      return { j: j, k: keyOf(j, s.key, ctx), n: text(numberOf(j)), id: String(j.id == null ? '' : j.id) };
    });
    rows.sort(function (x, y) {
      if (x.k == null || y.k == null) {
        if (x.k != null) return -1;          // missing sorts last, both directions
        if (y.k != null) return 1;
      } else {
        var c = cmp(x.k, y.k);
        if (c) return c * flip;
      }
      if (x.n == null || y.n == null) {
        if (x.n != null) return -1;
        if (y.n != null) return 1;
      } else {
        var t = cmpText(x.n, y.n);
        if (t) return t;
      }
      return cmpPlain(x.id, y.id);
    });
    return rows.map(function (r) { return r.j; });
  }

  // ── remembered per browser ────────────────────────────────────────
  // Whitelisted on read, so a stale or hand-edited value falls back to the
  // default rather than to nothing; every access guarded (a full or blocked
  // store throws).
  function load(storage) {
    try {
      var v = (storage || root.localStorage).getItem(STORAGE_KEY);
      return valid(v) ? v : DEFAULT_ID;
    } catch (e) { return DEFAULT_ID; }
  }
  function save(id, storage) {
    if (!valid(id)) return;
    try { (storage || root.localStorage).setItem(STORAGE_KEY, id); } catch (e) { /* not remembered, still applied */ }
  }

  var api = {
    STORAGE_KEY: STORAGE_KEY,
    DEFAULT_ID: DEFAULT_ID,
    SORTS: SORTS,
    valid: valid,
    spec: spec,
    menuFor: menuFor,
    headerNext: headerNext,
    headerMark: headerMark,
    sort: sortJobs,
    // Exported because the Jobs list FILTERS on the same word this ranks by.
    btWord: btWord,
    btRank: btRank,
    BT_ORDER: BT_ORDER,
    load: load,
    save: save
  };
  root.p86JobsSort = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
