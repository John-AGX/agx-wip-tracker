// Job label — the ONE place a job's number and title are composed into a
// human string. The owner's standard (John, 2026-08-16):
//
//     RV2006 Waterside 1 Siding Replacement
//
// jobNumber + a single space + title. No em dash, no hyphen, no pipe, no
// brackets. Before this module the app carried SIX incompatible formats
// ("RV2006 — Waterside", "[RV2006] Waterside", "RV2006 · Waterside",
// "RV2006 Waterside", "RV2006" alone, "Waterside" alone), and js/jobs.js
// contradicted itself inside one file: the sort keys already joined with a
// space while the row it sorted rendered an em dash.
//
// Why one shared module and not N local fixes: job labels are FORWARD-FACING.
// The same composition reaches a PO handed to a sub, a change order a client
// signs, an AIA G702 PROJECT field an owner/architect reads, crew SMS, and
// assignment emails. A client seeing one format on a proposal and another in
// a portal is the failure this prevents — so the format has to have exactly
// one definition.
//
// Loaded on BOTH sides, same as js/assembly-formula.js and
// js/pricing-pipeline.js: `window.p86JobLabel` in the browser,
// `require('.../js/job-label')` on the server. There is no server/client
// split of this logic — a split is exactly how the six formats happened.
// The function is pure (no `pg`, no `window`, no DOM), so it loads anywhere.
//
//   p86JobLabel(number, title[, opts])   -> 'RV2006 Waterside 1'
//   p86JobLabel.fromJob(jobLike[, opts]) -> reads jobNumber/job_number + title/job_title/name
//
//   opts.fallback — what to render when BOTH parts are empty. Default
//   'Untitled job'. Never returns 'undefined', 'null', ' — ', or a bare id.
(function () {
  'use strict';

  var DEFAULT_FALLBACK = 'Untitled job';

  // Only strings/numbers are label material. An object, array, boolean or
  // NaN yields '' rather than '[object Object]' / 'true' / 'NaN'.
  function clean(v) {
    if (v == null) return '';
    if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
    if (typeof v !== 'string') return '';
    return v.trim();
  }

  // The formatter. Four cases, and the separator exists ONLY when there are
  // two things to separate — that is what kept producing a stranded
  // "RV2006 — " (workspace-layout.js) or a leading " — " (numberless jobs).
  function jobLabel(number, title, opts) {
    var n = clean(number);
    var t = clean(title);
    if (n && t) return n + ' ' + t;
    if (n) return n;
    if (t) return t;
    var fb = opts && opts.fallback;
    return (typeof fb === 'string' && fb.trim()) ? fb : DEFAULT_FALLBACK;
  }

  // Key aliases, in priority order. Jobs come in three shapes across the app:
  // the client's appData record (jobNumber/title), a server JSONB read
  // (jobNumber/title), and a joined list row (job_number/job_title).
  // `number` is deliberately NOT an alias — on a PO/invoice row it is the
  // document's own number, not the job's.
  var NUMBER_KEYS = ['jobNumber', 'job_number'];
  var TITLE_KEYS = ['title', 'job_title', 'jobName', 'name'];

  function pick(obj, keys) {
    for (var i = 0; i < keys.length; i++) {
      var v = clean(obj[keys[i]]);
      if (v) return v;
    }
    return '';
  }

  // Convenience for a whole job-shaped record. A null/!object argument gives
  // the fallback, so `fromJob(jobs.find(...))` is safe on a miss.
  function fromJob(job, opts) {
    if (!job || typeof job !== 'object') return jobLabel('', '', opts);
    return jobLabel(pick(job, NUMBER_KEYS), pick(job, TITLE_KEYS), opts);
  }

  jobLabel.fromJob = fromJob;
  jobLabel.DEFAULT_FALLBACK = DEFAULT_FALLBACK;
  jobLabel.NUMBER_KEYS = NUMBER_KEYS;
  jobLabel.TITLE_KEYS = TITLE_KEYS;

  if (typeof module !== 'undefined' && module.exports) module.exports = jobLabel;
  if (typeof window !== 'undefined') window.p86JobLabel = jobLabel;
})();
