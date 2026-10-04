'use strict';

/**
 * job-status-filter.js — what a job status FILTER means when a person (or 86)
 * says it, and how to count jobs by state.
 *
 * WHY THIS FILE EXISTS
 *
 * read_jobs and read_wip_summary each compared the caller's `status` against a
 * job's own status with one exact, case-insensitive string compare. So
 * `status: 'active'` — the most natural thing anybody asks for, and the first
 * thing 86 reaches for — matched NOTHING, and the tool answered "No jobs with
 * status active" to a question about 46 live jobs.
 *
 * That silence is expensive, and it was measured: one count question
 * ("how many active jobs are there right now?") became three tool calls and
 * ~27,000 characters of job rows, because the cheap filter could not match and
 * the model fell back to enumerating the portfolio. A filter that cannot
 * express the question makes the model pay for the answer in rows.
 *
 * "Active" is not a status, it is four of them. The mapping already exists and
 * is already pinned: services/clickr/bt-match.js p86JobState() puts New,
 * Backlog, In Progress and On Hold under `active`, and Warranty, Completed and
 * Archived each under their own state, with test/job-status-vocabulary.test.js
 * asserting every one of the seven. Reusing it is the point of this file —
 * a second mapping here is how the two would drift.
 *
 * AN EXACT STATUS STILL WINS. `status: 'On Hold'` keeps behaving exactly as it
 * did, so nothing that worked before this file changes.
 */

const { p86JobState } = require('./clickr/bt-match');

// The four state words a filter may use, as the pinned mapping defines them.
const JOB_STATES = ['active', 'warranty', 'completed', 'archived'];

const norm = (v) => String(v == null ? '' : v).trim().toLowerCase().replace(/\s+/g, ' ');

/** True when `filter` names one of the four states rather than a raw status. */
function isStateWord(filter) {
  return JOB_STATES.indexOf(norm(filter)) !== -1;
}

/**
 * Does this job's status satisfy the caller's filter?
 *
 * No filter matches everything. A STATE word matches every status that maps to
 * it. Anything else is compared exactly (case- and space-insensitively), which
 * is what both call sites did before.
 */
function matchesJobStatus(jobStatus, filter) {
  const f = norm(filter);
  if (!f) return true;
  if (isStateWord(f)) return p86JobState(jobStatus) === f;
  return norm(jobStatus) === f;
}

/**
 * Count jobs by state, and by the statuses inside each state.
 *
 * This is what a count question actually wants: "how many active jobs" and
 * "how many are on hold" are the same question at two depths, and answering
 * both costs one line instead of a portfolio. A status the pinned vocabulary
 * does not recognise is counted under `unknown` BY NAME rather than dropped —
 * a job missing from a total is worse than a job in an ugly bucket.
 */
function jobStateHistogram(statuses) {
  const list = Array.isArray(statuses) ? statuses : [];
  const out = { total: list.length, states: {}, unknown: {} };
  for (const st of JOB_STATES) out.states[st] = { count: 0, statuses: {} };
  for (const raw of list) {
    const state = p86JobState(raw);
    const label = String(raw == null || raw === '' ? '(no status)' : raw);
    if (state && out.states[state]) {
      out.states[state].count += 1;
      out.states[state].statuses[label] = (out.states[state].statuses[label] || 0) + 1;
    } else {
      out.unknown[label] = (out.unknown[label] || 0) + 1;
    }
  }
  return out;
}

/**
 * The histogram as one line for a model to read.
 *
 * Deliberately one line: the whole point is that a count must not cost rows.
 * States with no jobs are left out, so a tidy portfolio reads tidily, and the
 * statuses inside each state ride in brackets so the follow-up question
 * ("how many on hold?") is already answered and needs no second call.
 */
function formatJobCount(histogram, opts) {
  const h = histogram || { total: 0, states: {}, unknown: {} };
  const o = opts || {};
  const noun = h.total === 1 ? 'job' : 'jobs';
  const parts = [];
  for (const st of JOB_STATES) {
    const s = h.states[st];
    if (!s || !s.count) continue;
    const inner = Object.keys(s.statuses).sort()
      .map((k) => k + ' ' + s.statuses[k]).join(' · ');
    parts.push(st + ' ' + s.count + (inner ? ' (' + inner + ')' : ''));
  }
  for (const k of Object.keys(h.unknown).sort()) {
    parts.push('unrecognised status "' + k + '" ' + h.unknown[k]);
  }
  const head = h.total + ' ' + noun + (o.scope ? ' ' + o.scope : '');
  return parts.length ? head + ' — ' + parts.join(' · ') + '.' : head + '.';
}

module.exports = {
  JOB_STATES,
  isStateWord,
  matchesJobStatus,
  jobStateHistogram,
  formatJobCount,
};
