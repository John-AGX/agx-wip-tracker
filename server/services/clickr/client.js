'use strict';
// ── CLICKR DATASET READER — COMPLETE ONLY WHEN CLICKR SAYS SO ────────────────
//
// Production path: GET https://api.clickr.cloud/v2/datasets/{id}/records with
// `Authorization: Bearer <CLICKR_API_KEY>` (verified synchronous; unauthenticated
// calls answer 401). The REST envelope itself has NOT been seen. What HAS been
// seen is the Clickr web app's own read of the same data (tRPC
// datasets.listRecords), which answers { recordType, columns, records, count,
// sort } and pages with skip/limit. This reader is built for that shape.
//
// A read is COMPLETE only when BOTH hold:
//   * the loop ended on Clickr's own end signal — a page with no next link, a
//     cursor with hasMore false, or (skip/limit) a page shorter than the limit
//     we asked for; and
//   * the number of records fetched equals the count Clickr reported.
// Everything else is PARTIAL with the reason in a sentence: no count, a count
// that is not a plain whole number ("1,234"), a count that changed mid-read,
// more records than the count (the count was a page size), a short page before
// the count was reached, a repeated page (a paging parameter Clickr ignores),
// two empty pages in a row while Clickr still signalled more, a malformed or
// off-host next link, a later page failing, the page cap, or the deadline.
//
// THE KEY NEVER LEAVES THIS FILE. It goes into one request header. Clickr's
// error bodies are NEVER read into a message — each HTTP status maps to a
// fixed sentence — transport exceptions are never echoed, and a next link is
// never echoed either (its host is not named).

const DEFAULT_BASE = 'https://api.clickr.cloud';
const MIN_KEY_LENGTH = 16;
const LIMITS = {
  pageSize: 200,          // the limit the Clickr app itself uses
  pageTimeoutMs: 10000,   // one HTTP request, body included
  deadlineMs: 30000,      // one whole dataset, all pages
  maxPages: 60,
};

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

const RECORD_KEYS = ['records', 'data', 'items'];
const COUNT_KEYS = ['count', 'total', 'totalCount'];
const LINK_KEYS = ['next', 'nextUrl', 'nextPageUrl'];
const CURSOR_KEYS = ['nextCursor', 'next_cursor', 'cursor'];
const MORE_KEYS = ['hasMore', 'has_more'];

function pick(body, keys) {
  if (!isPlainObject(body)) return undefined;
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(body, k) && body[k] !== undefined) return { key: k, value: body[k] };
  }
  if (isPlainObject(body.meta)) return pick(body.meta, keys);
  return undefined;
}

// { value } for a plain non-negative whole number, { invalid: true } for
// anything else that was sent, undefined when nothing was sent.
function readCount(body) {
  const hit = pick(body, COUNT_KEYS);
  if (!hit || hit.value === null) return undefined;
  const v = hit.value;
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return { value: v, at: hit.key };
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return { value: Number(v.trim()), at: hit.key };
  return { invalid: true, at: hit.key };
}

function statusSentence(status, label) {
  if (status === 401 || status === 403) {
    return { kind: 'unauthorized', message: 'Clickr refused the key for the ' + label + ' dataset (HTTP ' + status + '). The CLICKR_API_KEY on this server is wrong, revoked, or has no access to this dataset.' };
  }
  if (status === 404) {
    return { kind: 'not_found', message: 'Clickr has no ' + label + ' dataset at the configured id (HTTP 404). It may have been deleted or re-created under a new id.' };
  }
  if (status === 429) {
    return { kind: 'rate_limited', message: 'Clickr rate-limited the ' + label + ' request (HTTP 429). Try again in a minute.' };
  }
  if (status >= 500 && status <= 599) {
    return { kind: 'upstream', message: 'Clickr failed on its side while serving the ' + label + ' dataset (HTTP ' + status + ').' };
  }
  const code = Number.isInteger(status) && status >= 100 && status <= 599 ? 'HTTP ' + status : 'an unreadable status';
  return { kind: 'http', message: 'Clickr answered the ' + label + ' request with ' + code + ', which this preview does not accept.' };
}

// The default transport. The timer covers the headers AND the body read, and
// aborting the controller really cancels the request. redirect:'error' — a
// redirect would carry the Authorization header somewhere this code never chose.
async function fetchTransport(url, opts) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs);
  try {
    const r = await fetch(url, { headers: opts.headers, signal: ctrl.signal, redirect: 'error' });
    const text = await r.text();
    return { status: r.status, text };
  } catch (e) {
    if (ctrl.signal.aborted) {
      const te = new Error('timed out');
      te.code = 'TIMEOUT';
      throw te;
    }
    const ne = new Error('transport');
    ne.code = 'TRANSPORT';
    throw ne;
  } finally {
    clearTimeout(timer);
  }
}

function recordId(r) {
  if (!isPlainObject(r)) return null;
  for (const k of ['jobId', 'leadId', '_id', 'id']) {
    if (r[k] != null && (typeof r[k] === 'string' || typeof r[k] === 'number')) return k + ':' + r[k];
  }
  return null;
}

function pageSignature(records) {
  if (!records.length) return null;
  const ids = records.map(recordId);
  if (ids.every(Boolean)) return records.length + '|' + ids[0] + '|' + ids[ids.length - 1];
  try {
    return records.length + '|' + JSON.stringify(records[0]) + '|' + JSON.stringify(records[records.length - 1]);
  } catch (e) {
    return null;
  }
}

// Read every page of one dataset. Never throws; the result says what happened.
async function fetchDataset(opts) {
  const apiKey = opts.apiKey;
  const label = opts.label || 'dataset';
  const limits = Object.assign({}, LIMITS, opts.limits || {});
  const transport = opts.transport || fetchTransport;
  const now = opts.now || Date.now;
  const base = new URL(opts.baseUrl || DEFAULT_BASE);
  const recordsPath = '/v2/datasets/' + encodeURIComponent(opts.datasetId) + '/records';
  const pageUrl = (params) => {
    const u = new URL(recordsPath, base);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
    return u.toString();
  };

  const result = {
    label, records: [], fetched: 0, pages: 0, reportedCount: null, mode: null,
    complete: false, reason: null, error: null, elapsedMs: 0,
  };
  const started = now();
  const partial = (why) => { result.reason = why; };

  if (!apiKey) {
    result.error = { kind: 'missing_key', message: 'CLICKR_API_KEY is not set on this server, so nothing was fetched from Buildertrend.' };
    return result;
  }
  // A key this short cannot be a real Clickr key, and the response check that
  // withholds an echoed key needs a key long enough to recognise.
  if (String(apiKey).length < MIN_KEY_LENGTH) {
    result.error = { kind: 'bad_key', message: 'CLICKR_API_KEY on this server is too short (under ' + MIN_KEY_LENGTH + ' characters) to be a real Clickr key, so nothing was fetched from Buildertrend.' };
    return result;
  }

  const headers = { Authorization: 'Bearer ' + apiKey, Accept: 'application/json' };
  let url = pageUrl({ skip: 0, limit: limits.pageSize });
  let endSignal = false;
  let countInvalid = false;
  let countChanged = false;
  let emptyStreak = 0;
  const seenPages = new Set();
  const seenIds = new Set();
  let duplicateIds = 0;

  while (url) {
    if (result.pages >= limits.maxPages) { partial('the read stopped at the ' + limits.maxPages + '-page cap'); break; }
    const remaining = limits.deadlineMs - (now() - started);
    if (remaining <= 0) { partial('the read stopped at the ' + Math.round(limits.deadlineMs / 1000) + '-second time limit'); break; }
    const pageNo = result.pages + 1;
    const fail = (err) => {
      if (result.pages === 0) result.error = err;
      else partial('page ' + pageNo + ' failed: ' + err.message.replace(/\.$/, ''));
    };

    let resp;
    try {
      resp = await transport(url, { headers, timeoutMs: Math.min(limits.pageTimeoutMs, remaining) });
    } catch (e) {
      fail(e && e.code === 'TIMEOUT'
        ? { kind: 'timeout', message: 'Clickr did not answer the ' + label + ' request in time (page ' + pageNo + ').' }
        : { kind: 'transport', message: 'Could not reach Clickr for the ' + label + ' dataset (page ' + pageNo + ').' });
      break;
    }
    const status = Number(resp && resp.status);
    if (!(status >= 200 && status < 300)) { fail(statusSentence(status, label)); break; }
    let body;
    try {
      body = JSON.parse(resp && resp.text != null ? String(resp.text) : '');
    } catch (e) {
      fail({ kind: 'malformed', message: 'Clickr answered the ' + label + ' request with a body that is not JSON.' });
      break;
    }
    if (body === null) {
      fail({ kind: 'malformed', message: 'Clickr answered the ' + label + ' request with an empty (null) JSON body, so there were no records and no count.' });
      break;
    }
    let records;
    if (Array.isArray(body)) {
      records = body;
      if (!result.mode) result.mode = 'bare list';
    } else if (isPlainObject(body)) {
      const hit = pick(body, RECORD_KEYS);
      if (!hit || !Array.isArray(hit.value)) {
        fail({ kind: 'malformed', message: 'Clickr answered the ' + label + ' request with JSON that has no "records" list, so it is not the expected {records, count} response.' });
        break;
      }
      records = hit.value;
    } else {
      fail({ kind: 'malformed', message: 'Clickr answered the ' + label + ' request with a JSON ' + typeof body + ' instead of {records, count}.' });
      break;
    }

    const sig = pageSignature(records);
    if (sig && seenPages.has(sig)) {
      partial('page ' + pageNo + ' repeated a page already received, so paging was not advancing (Clickr may ignore the paging parameter sent)');
      break;
    }
    if (sig) seenPages.add(sig);
    result.pages = pageNo;
    for (const r of records) {
      const id = recordId(r);
      if (id) {
        if (seenIds.has(id)) duplicateIds++;
        seenIds.add(id);
      }
      result.records.push(r);
    }
    result.fetched = result.records.length;

    const c = Array.isArray(body) ? undefined : readCount(body);
    if (c && c.invalid) countInvalid = true;
    else if (c) {
      if (result.reportedCount != null && result.reportedCount !== c.value) countChanged = true;
      if (result.reportedCount == null) result.reportedCount = c.value;
    }

    // What comes next — from THIS page's body.
    const link = Array.isArray(body) ? undefined : pick(body, LINK_KEYS);
    const cursor = Array.isArray(body) ? undefined : pick(body, CURSOR_KEYS);
    const moreHit = Array.isArray(body) ? undefined : pick(body, MORE_KEYS);
    const hasMore = moreHit && typeof moreHit.value === 'boolean' ? moreHit.value : null;
    emptyStreak = records.length === 0 ? emptyStreak + 1 : 0;

    if (link && typeof link.value === 'string' && link.value.trim() !== '') {
      result.mode = result.mode || 'next link';
      let next;
      try {
        next = new URL(link.value, url);
      } catch (e) {
        partial('Clickr\'s next-page link on page ' + pageNo + ' could not be read');
        break;
      }
      // ORIGIN, not hostname: an http:// link to the same host would send the
      // key in cleartext.
      if (next.origin !== base.origin) {
        partial('Clickr pointed the next page at a different host, port or scheme; it was not followed, so the key was not sent there');
        break;
      }
      if (emptyStreak >= 2) { partial('two pages in a row came back empty while Clickr still linked a next page'); break; }
      if (next.toString() === url) { partial('Clickr\'s next-page link pointed at the page just read'); break; }
      url = next.toString();
      continue;
    }
    if (link && link.value != null && typeof link.value !== 'string') {
      partial('Clickr\'s next-page link on page ' + pageNo + ' was not a link');
      break;
    }
    if (cursor && typeof cursor.value === 'string' && cursor.value !== '' && hasMore !== false) {
      result.mode = result.mode || 'cursor';
      if (emptyStreak >= 2) { partial('two pages in a row came back empty while Clickr still signalled more'); break; }
      url = pageUrl({ cursor: cursor.value, limit: limits.pageSize });
      continue;
    }
    if (result.mode === 'next link' || result.mode === 'cursor') {
      if (hasMore === true) { partial('Clickr signalled more records on page ' + pageNo + ' but gave no link or cursor to fetch them'); break; }
      endSignal = true;
      break;
    }
    // skip/limit (the Clickr app's own paging).
    result.mode = result.mode || 'skip/limit';
    if (records.length === 0) {
      if (hasMore === true) {
        if (emptyStreak >= 2) { partial('two pages in a row came back empty while Clickr still signalled more'); break; }
        url = pageUrl({ skip: result.fetched, limit: limits.pageSize });
        continue;
      }
      endSignal = true;
      break;
    }
    // The last page: shorter than the limit asked for, or Clickr saying so outright.
    if ((records.length < limits.pageSize && hasMore !== true) || hasMore === false) {
      endSignal = true;
      break;
    }
    url = pageUrl({ skip: result.fetched, limit: limits.pageSize });
  }

  result.elapsedMs = now() - started;
  return settleRead(result, { endSignal, countInvalid, countChanged, duplicateIds });
}

// The verdict on a finished page loop. Pure, so each rule is proved directly:
// today every loop exit either records a reason or sets endSignal, which makes
// the end-signal rule unreachable THROUGH the loop — this is what keeps a future
// loop exit that forgets both from being read as complete.
function settleRead(result, flags) {
  const f = flags || {};
  const partial = (why) => { result.reason = why; result.complete = false; return result; };
  result.complete = false;
  if (result.error) return result;
  if (result.reason) return result;
  if (f.endSignal !== true) return partial('the read ended without Clickr signalling the last page');
  if (f.countInvalid) return partial('Clickr reported a total that is not a plain whole number, so the read cannot be confirmed complete');
  if (result.reportedCount == null) return partial('Clickr reported no count, so there is nothing to confirm the ' + result.fetched + ' records against');
  if (f.countChanged) return partial('Clickr\'s reported count changed between pages');
  if (f.duplicateIds) return partial(f.duplicateIds + ' records arrived more than once, so paging drifted');
  if (result.fetched > result.reportedCount) {
    return partial('more records were fetched (' + result.fetched + ') than Clickr\'s count (' + result.reportedCount + '), so that count is not the dataset total');
  }
  if (result.fetched < result.reportedCount) {
    return partial('Clickr signalled the last page after ' + result.fetched + ' records, short of its count of ' + result.reportedCount);
  }
  result.complete = true;
  return result;
}

module.exports = { fetchDataset, settleRead, fetchTransport, statusSentence, readCount, LIMITS, DEFAULT_BASE, MIN_KEY_LENGTH };
