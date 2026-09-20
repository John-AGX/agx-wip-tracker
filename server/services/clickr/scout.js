'use strict';
// ── CLICKR DATASET SCOUT — WHAT A DATASET IS, WITHOUT READING WHAT IT SAYS ───
//
// WHY THIS EXISTS. Every key name in ./field-map.js was guessed from the labels
// Clickr's web UI prints, because reading the Clickr API needs CLICKR_API_KEY
// and only the deployed server holds it. The guessing has gone wrong three
// times: five real Bills keys were never declared because nobody knew they
// existed; 'item' was declared on the estimate worksheet and the real key is
// 'itemTitle'; and markupType was assumed to hold words ('percent', 'margin')
// when it holds numeric codes ('1', '5', '2'), which refused all 62 live
// worksheets. describeMapping() in field-map.js catches the first two halves of
// that — it names keys nobody declared and declared keys no record carries —
// but it can only run on a dataset that is ALREADY declared, and it never says
// anything about what the VALUES look like, which is the failure markupType was.
//
// This module answers both: point it at ANY Clickr dataset id, declared or not,
// and it reports the key names, how often each is carried and filled, how many
// distinct values each holds, and — only where a value cannot be personal or
// free text — the value histogram itself.
//
// ── THE DISCLOSURE RULE (the whole safety story) ─────────────────────────────
// A key's values are named only when ALL FOUR hold. Each is mechanical; none
// consults a field name, so a key nobody has ever seen is judged the same way
// as one we declared.
//
//   1. CARDINALITY — at most RULE.maxDistinct (12) distinct non-empty values.
//      Twelve is a vocabulary that fits on one line: a boolean (2), a
//      Buildertrend status list (Open / Closed / Pending / Warranty / ... runs
//      to about eight), a markup-type code set (1..5), a month. Free text over
//      any real dataset lands in the hundreds, not at twelve.
//   2. IDENTIFIER — distinctCount x RULE.recordsPerDistinct (4) must not exceed
//      the number of records that CARRY the key (its nonEmpty count, NOT the
//      dataset size): a key must average at least four records per distinct
//      value to be an enum rather than a per-record label. This is the
//      condition that withholds a short-valued key on a small dataset, where
//      rule 1 alone is meaningless (ten records, ten distinct values is an id,
//      not an enum). It also refuses every key on a dataset of three records.
//      The denominator is the FILL count because a sparse key is the dangerous
//      shape: a crew list carried by 12 of 578 task records has 12 distinct
//      values, which clears rule 1 and would clear this one against 578 — and
//      twelve people would be named. Against its own 12 rows it is refused.
//   3. SHAPE — every distinct value must be a scalar: a boolean, a number, or a
//      string. Objects and lists (contractPrice {value, scale}, contacts,
//      customFields) are counted and never named, because their insides cannot
//      be judged by the rules below.
//   4. TEXT — every distinct scalar must be
//        * at most RULE.maxValueChars (24) characters rendered. Enum labels fit
//          with room to spare ('Not Started' 11, 'In Progress' 11, 'Completed'
//          9, 'Warranty' 8); titles, street addresses and free text do not.
//        * carrying at most RULE.maxDigits (4) digit characters, which admits
//          codes, small counts, percentages and a year, and refuses telephone
//          numbers (10), postal codes (5), timestamps (8+), record ids and
//          money amounts.
//        * free of '@' and '://' — an address or a link is contact data even
//          when it is short.
//        * free of control characters and line breaks, which are free text.
//
// When a key fails any of these, its values are NOT named — not one of them,
// not a sample, not a shortest-or-longest. The response carries the count and a
// sentence that says which rule withheld it, and that sentence contains
// numbers only.
//
// WHAT THE RULE DOES NOT SEPARATE, said plainly: a column of people's names
// where the team is small and the names are short ('Ana Ruiz') is
// lexically indistinguishable from a column of statuses ('In Progress'), and
// every rule that refuses the first also refuses the second. The line drawn
// here keeps the enum and accepts that a small, short-valued name column can be
// counted and named. Everything reachable is already readable by this caller:
// the gate below admits exactly one organisation's ROLES_MANAGE admins, who can
// read every client, user, job and lead of that organisation through the
// ordinary app. Emails, telephone numbers, addresses, ids, dates, money and
// free text are closed by shape, which is what rules 3 and 4 buy.
//
// ── WHO MAY SEE IT ──────────────────────────────────────────────────────────
// Identical to ./sync-preview.js, and taken FROM it rather than restated:
//   1. the host route's requireAuth + requireOrg + requireCapability
//      ('ROLES_MANAGE'), before a line here runs;
//   2. ownerSlug() — imported from sync-preview so CLICKR_ORG_SLUG can never
//      mean two things — the caller's organisation must be the one the one
//      global CLICKR_API_KEY belongs to. SYSTEM_ADMIN buys nothing.
// The finished body then goes through sync-preview's carriesKey() before it is
// served: a dataset that happens to store this server's own Clickr key in a
// column would otherwise hand it back.
//
// ── READ-ONLY, STRUCTURALLY ─────────────────────────────────────────────────
// This module is handed no pool and requires no database module (see the route:
// it is called with an empty deps object). It reaches Clickr over GET and
// touches Project 86's records not at all.
//
// ── HOW IT IS REACHED ───────────────────────────────────────────────────────
// GET /api/admin/organizations/me?view=clickr-scout&dataset=<24 hex> — a THIRD
// MODE of that route, beside 'buildertrend-archive' and 'buildertrend-preview',
// so test/tenant-register2-http.test.js's committed route census does not move.

const crypto = require('crypto');
const { DATASETS, describeMapping } = require('./field-map');
const { fetchDataset } = require('./client');
const { ownerSlug, carriesKey } = require('./sync-preview');

const VIEW_PARAM = 'clickr-scout';

// A Clickr object id, exactly: 24 lowercase hexadecimal characters. Anything
// else is refused before a request is built, so no caller-supplied string is
// ever pasted into the Clickr base URL.
const DATASET_ID = /^[0-9a-f]{24}$/;

const RULE = {
  maxDistinct: 12,
  recordsPerDistinct: 4,
  maxValueChars: 24,
  maxDigits: 4,
};

// The response cap. At most 200 keys are described; a key's histogram holds at
// most RULE.maxDistinct entries of at most RULE.maxValueChars characters, so a
// full body is tens of kilobytes. MAX_BODY_BYTES is the backstop for a shape
// nobody predicted: histograms are dropped, largest first, then keys, until the
// body fits, and `truncated` says so.
const MAX_KEYS = 200;
const MAX_BODY_BYTES = 128 * 1024;
// Distinct values are tracked per key up to this many; past it the count is
// reported as "more than", and such a key is withheld by rule 1 regardless.
const MAX_DISTINCT_TRACKED = 1000;

// ── THE MISSING idKey ───────────────────────────────────────────────────────
// client.js dedupes records by a dataset's OWN id key, named in field-map.js.
// An undeclared dataset has none, and GUESSING one is the specific mistake that
// once made a whole read look partial and blocked every apply: every change
// order and purchase order also carries its JOB's jobId, so a job's second row
// read as the first arriving again.
//
// So nothing is guessed. A declared dataset is scouted with its declared idKey;
// an undeclared one is handed this sentinel, which no JSON key from Clickr can
// be. client.js then finds no id on any record, the duplicate counter stays at
// zero, and its repeated-page check falls back to comparing whole first and
// last records — which still catches a paging parameter Clickr ignores. What is
// lost is only the "records arrived twice" signal; what is kept is the check
// that actually settles the question, fetched === Clickr's own reported count.
// A wrong idKey would have cost that instead.
const NO_ID_KEY = ' scout:no-declared-id-key';

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

// 0 and false are VALUES. A blank string, an empty list and an empty object are
// not: they are the field being unfilled, which is what nonEmpty counts.
function isEmpty(v) {
  if (v == null) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v).length === 0;
  return false;
}

// A value's identity for the distinct count. Scalars are their own identity;
// anything else is hashed, so an object's insides are counted and never held.
function token(v) {
  if (typeof v === 'string') return 's:' + v;
  if (typeof v === 'number') return 'n:' + String(v);
  if (typeof v === 'boolean') return 'b:' + (v ? '1' : '0');
  let j;
  try { j = JSON.stringify(v); } catch (e) { j = null; }
  return 'h:' + crypto.createHash('sha256').update(j == null ? 'unserialisable' : j).digest('hex').slice(0, 32);
}

// Rules 3 and 4, on ONE value. null when the value may be named, otherwise the
// code of the rule that refuses it.
function shapeProblem(v) {
  if (typeof v === 'boolean') return null;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return 'shape';
    const digits = String(v).replace(/[^0-9]/g, '').length;
    if (digits > RULE.maxDigits) return 'digits';
    if (String(v).length > RULE.maxValueChars) return 'length';
    return null;
  }
  if (typeof v !== 'string') return 'shape';
  if (v.length > RULE.maxValueChars) return 'length';
  if (/[ -]/.test(v)) return 'control';
  if (v.indexOf('@') !== -1 || v.indexOf('://') !== -1) return 'contact';
  if ((v.match(/[0-9]/g) || []).length > RULE.maxDigits) return 'digits';
  return null;
}

// Every sentence below carries counts and rule thresholds ONLY. None of them
// takes a value, a sample or a length measured off a real value.
function withheldSentence(code, st, recordCount) {
  const n = st.distinctExact ? st.distinctCount + ' distinct values' : 'more than ' + MAX_DISTINCT_TRACKED + ' distinct values';
  if (code === 'cardinality') {
    return n + ' — more than the ' + RULE.maxDistinct + ' this diagnostic will name, so the values are counted and not shown.';
  }
  if (code === 'identifier') {
    return n + ' across the ' + recordCount + ' records that carry this key (fewer than ' + RULE.recordsPerDistinct
      + ' records per value), so this key labels records rather than grouping them; the values are counted and not shown.';
  }
  if (code === 'shape') {
    return 'the values are objects or lists, which are never shown; ' + n + '.';
  }
  if (code === 'length') {
    return 'at least one value is longer than ' + RULE.maxValueChars + ' characters, so this key may hold a title, an address or free text; ' + n + '.';
  }
  if (code === 'digits') {
    return 'at least one value carries more than ' + RULE.maxDigits
      + ' digits, so this key may hold an id, a telephone number, a postal code, a date or an amount; ' + n + '.';
  }
  if (code === 'contact') {
    return 'at least one value carries "@" or a link, so this key may hold contact information; ' + n + '.';
  }
  if (code === 'control') {
    return 'at least one value carries line breaks or control characters, so this key holds free text; ' + n + '.';
  }
  return n + '; the values are counted and not shown.';
}

// ── THE SUMMARY ─────────────────────────────────────────────────────────────
// Pure: records in, counts out. Every disclosure decision lives here, so each
// rule can be executed directly by a test rather than inferred from a response.
function summarize(records) {
  const recs = Array.isArray(records) ? records : [];
  let notObjects = 0;
  const stats = new Map();

  for (const r of recs) {
    if (!isPlainObject(r)) { notObjects++; continue; }
    for (const k of Object.keys(r)) {
      let st = stats.get(k);
      if (!st) {
        st = { key: k, carriedBy: 0, nonEmpty: 0, distinct: new Set(), distinctOverflow: false, counts: new Map(), problem: null };
        stats.set(k, st);
      }
      st.carriedBy++;
      const v = r[k];
      if (isEmpty(v)) continue;
      st.nonEmpty++;
      const t = token(v);
      if (!st.distinct.has(t)) {
        if (st.distinct.size < MAX_DISTINCT_TRACKED) st.distinct.add(t);
        else st.distinctOverflow = true;
      }
      const hit = st.counts.get(t);
      if (hit) hit.count++;
      // One more entry than the rule will ever name: enough to know the cap was
      // passed, never enough to hold a large dataset's values in memory.
      else if (st.counts.size <= RULE.maxDistinct) st.counts.set(t, { value: v, count: 1 });
      if (st.problem == null) st.problem = shapeProblem(v);
    }
  }

  const all = [...stats.values()].sort((a, b) => b.carriedBy - a.carriedBy || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const fields = all.slice(0, MAX_KEYS).map((st) => {
    const distinctCount = st.distinct.size;
    const distinctExact = !st.distinctOverflow;
    const out = {
      key: st.key,
      carriedBy: st.carriedBy,
      nonEmpty: st.nonEmpty,
      distinctCount: distinctCount,
      distinctExact: distinctExact,
      values: null,
      withheld: null,
    };
    const ctx = { distinctCount: distinctCount, distinctExact: distinctExact };
    if (st.nonEmpty === 0) { out.values = []; return out; }
    let code = null;
    if (!distinctExact || distinctCount > RULE.maxDistinct) code = 'cardinality';
    else if (distinctCount * RULE.recordsPerDistinct > st.nonEmpty) code = 'identifier';
    else if (st.problem) code = st.problem;
    if (code) {
      out.withheld = withheldSentence(code, ctx, st.nonEmpty);
      out.withheldRule = code;
      return out;
    }
    out.values = [...st.counts.values()]
      .map((e) => ({ value: e.value, count: e.count }))
      .sort((a, b) => b.count - a.count || (String(a.value) < String(b.value) ? -1 : String(a.value) > String(b.value) ? 1 : 0));
    return out;
  });

  return { recordCount: recs.length, notObjects: notObjects, keysTotal: all.length, keysReported: fields.length, fields: fields };
}

function declaredFor(datasetId) {
  for (const k of Object.keys(DATASETS)) {
    if (DATASETS[k].datasetId === datasetId) return DATASETS[k];
  }
  return null;
}

function capSize(body) {
  body.truncated = false;
  if (JSON.stringify(body).length <= MAX_BODY_BYTES) return body;
  const named = body.fields.filter((f) => Array.isArray(f.values) && f.values.length);
  named.sort((a, b) => JSON.stringify(b.values).length - JSON.stringify(a.values).length);
  for (const f of named) {
    f.values = null;
    f.withheld = 'The response was already at its size cap, so this key\'s values were dropped.';
    f.withheldRule = 'response-size';
    body.truncated = true;
    if (JSON.stringify(body).length <= MAX_BODY_BYTES) return body;
  }
  while (body.fields.length > 1 && JSON.stringify(body).length > MAX_BODY_BYTES) {
    body.fields.pop();
    body.keysReported = body.fields.length;
    body.truncated = true;
  }
  return body;
}

async function scoutDataset(datasetId, deps) {
  const d = deps || {};
  const env = d.env || process.env;
  const apiKey = env.CLICKR_API_KEY ? String(env.CLICKR_API_KEY).trim() : '';
  const started = (d.now || Date.now)();
  const declared = declaredFor(datasetId);

  const fr = await fetchDataset({
    apiKey: apiKey,
    datasetId: datasetId,
    label: declared ? declared.label : 'scouted',
    idKey: declared ? declared.idKey : NO_ID_KEY,
    transport: d.transport,
    limits: d.limits,
    now: d.now,
    baseUrl: d.baseUrl,
  });

  const summary = summarize(fr.records);
  const body = {
    readOnly: true,
    readOnlyNote: 'A diagnostic. Nothing is written to Project 86 or to Buildertrend, and no Project 86 record is read.',
    generatedAt: new Date().toISOString(),
    organization: d.organization || null,
    keyConfigured: !!apiKey,
    dataset: {
      id: datasetId,
      declaredAs: declared ? declared.key : null,
      label: declared ? declared.label : null,
    },
    fetch: {
      complete: fr.complete === true,
      reason: fr.reason || null,
      error: fr.error || null,
      fetched: fr.fetched,
      pages: fr.pages,
      reportedCount: fr.reportedCount,
      mode: fr.mode,
      elapsedMs: fr.elapsedMs,
      idKey: declared ? declared.idKey : null,
      idKeyNote: declared
        ? 'Duplicate records are recognised by this dataset\'s declared id key.'
        : 'This dataset is not declared in field-map.js, so no id key was guessed: repeated pages are caught by comparing whole records, and completeness rests on the fetched count matching Clickr\'s own total.',
    },
    recordCount: summary.recordCount,
    notObjects: summary.notObjects,
    keysTotal: summary.keysTotal,
    keysReported: summary.keysReported,
    disclosure: {
      maxDistinct: RULE.maxDistinct,
      recordsPerDistinct: RULE.recordsPerDistinct,
      maxValueChars: RULE.maxValueChars,
      maxDigits: RULE.maxDigits,
      note: 'Values are named only for a key with at most ' + RULE.maxDistinct + ' distinct values, averaging at least '
        + RULE.recordsPerDistinct + ' records per value, every one of them a boolean, a number or a string of at most '
        + RULE.maxValueChars + ' characters carrying at most ' + RULE.maxDigits + ' digits, no "@", no link and no line breaks. '
        + 'Every other key is counted only.',
    },
    fields: summary.fields,
  };
  // The declared half of the diagnostic, when the dataset IS declared: the same
  // answer describeMapping() already gives on the preview, so both halves are
  // in one place and neither is re-implemented here.
  if (declared) {
    const m = describeMapping(declared.key, fr.records);
    body.declared = {
      key: declared.key,
      requiredKey: m.requiredKey,
      requiredOk: m.requiredOk,
      missingKeys: m.missingKeys,
      unexpectedKeys: m.unexpectedKeys,
    };
  }
  body.elapsedMs = (d.now || Date.now)() - started;
  capSize(body);
  if (carriesKey(body, apiKey)) {
    throw Object.assign(new Error('withheld'), { keyLeak: true });
  }
  return body;
}

// Called from GET /api/admin/organizations/me AFTER requireAuth, requireOrg and
// requireCapability('ROLES_MANAGE') have all passed.
async function handle(req, res, deps) {
  const d = deps || {};
  const env = d.env || process.env;
  const org = req.organization;
  if (!org || org.id == null) {
    return res.status(403).json({ error: 'The Clickr dataset scout needs an organization.' });
  }
  if (String(org.slug || '') !== ownerSlug(env)) {
    return res.status(403).json({
      error: 'The Clickr dataset scout is not available for this organization. The Buildertrend connection on this server belongs to a different company.',
      code: 'CLICKR_NOT_THIS_ORG',
    });
  }
  const asked = req.query && req.query.dataset != null ? String(req.query.dataset) : '';
  if (!DATASET_ID.test(asked)) {
    return res.status(400).json({
      error: 'A Clickr dataset id is 24 lowercase hexadecimal characters. Nothing was asked of Clickr.',
      code: 'CLICKR_BAD_DATASET_ID',
    });
  }
  try {
    const body = await scoutDataset(asked, Object.assign({}, d, {
      env: env,
      organization: { id: org.id, slug: org.slug, name: org.name },
    }));
    res.set('Cache-Control', 'no-store');
    return res.json(body);
  } catch (e) {
    // Fixed sentences only: an exception message could carry anything.
    const leak = !!(e && e.keyLeak);
    console.error('[clickr-scout] ' + (leak ? 'response withheld: it contained the Clickr API key' : 'scout failed'));
    return res.status(500).json({
      error: leak
        ? 'The Clickr dataset scout was withheld because the response contained the Clickr API key.'
        : 'The Clickr dataset scout failed inside this server.',
    });
  }
}

module.exports = {
  handle,
  scoutDataset,
  summarize,
  shapeProblem,
  declaredFor,
  RULE,
  DATASET_ID,
  VIEW_PARAM,
  MAX_KEYS,
  MAX_BODY_BYTES,
  MAX_DISTINCT_TRACKED,
  NO_ID_KEY,
};
