'use strict';

// WHAT BECAME OF A WRITE — told to the agent, every turn.
//
// WHY THIS EXISTS (2026-09-21). John asked 86 to turn the Fairways emails into
// tasks. The Scribe refused the batch (a name where a user id goes); later it
// refused the work order too (an assignee on every building). Both refusals
// were posted into the chat thread by the server — and 86 never saw either,
// because a managed session's history is its own: a row the server writes into
// ai_messages is on John's screen, not in 86's context. So when John asked
// "where are we", 86 checked his to-do list, found nothing, and told him the
// tasks were "still waiting on the approval card". They had failed hours
// before. It inferred an outcome from an absence, and the absence fitted the
// wrong story.
//
// The existing turn-context blocks could not have saved it:
//   <recent_applied_payloads>  applied only, last 10 minutes;
//   <recent_failed_payloads>   failed WITH apply_error_detail, last hour — and a
//                              Scribe refusal is recorded without detail
//                              (services/scribe-refusal.js), so it never
//                              qualified, at any age.
// Nothing at all said a draft was still waiting.
//
// This block is the answer to "did it go through?", read from the one place
// that knows: the payloads row. Every outcome, the last day, newest first.

const WINDOW_HOURS = 24;
const MAX_ROWS = 8;
const TITLE_MAX = 90;
const REASON_MAX = 220;

function parseTargets(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try { const t = JSON.parse(v); return Array.isArray(t) ? t : null; } catch (e) { return null; }
  }
  return null;
}

// payloads.status → what the agent says. A 'failed' row with an EMPTY targets
// array is a Scribe refusal (scribe-refusal.js writes exactly that shape): no
// change was ever drafted. With targets, the draft existed and its apply broke.
function outcomeOf(row) {
  const status = String((row && row.status) || '').trim();
  if (status === 'ready') return 'WAITING FOR APPROVAL';
  if (status === 'applying') return 'APPLYING';
  if (status === 'applied') return 'APPLIED';
  if (status === 'rejected') return 'REJECTED';
  if (status === 'failed') {
    const targets = parseTargets(row.targets);
    return targets && targets.length === 0 ? 'REFUSED' : 'FAILED';
  }
  return status ? status.toUpperCase() : 'UNKNOWN';
}

function clip(s, n) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

function age(then, now) {
  const ms = now - new Date(then).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  const min = Math.round(ms / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return min + ' min ago';
  const h = Math.round(min / 60);
  return h + (h === 1 ? ' hour ago' : ' hours ago');
}

// The block, or '' when there is nothing to say. Pure: rows in, text out.
function recentWritesBlock(rows, nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  // The window is held HERE as well as in the query: the rows are told to the
  // agent as "the last day", so a row the query let through for any reason (a
  // clock skew, an engine that reads the interval differently) must not be
  // printed as if it belonged to today.
  const cutoff = now - WINDOW_HOURS * 3600000;
  const list = (Array.isArray(rows) ? rows : [])
    .filter((r) => { const t = new Date(r && r.created_at).getTime(); return Number.isFinite(t) && t >= cutoff; })
    .slice(0, MAX_ROWS);
  if (!list.length) return '';
  const lines = [
    '<recent_writes>',
    'Every change drafted for this user in the last ' + WINDOW_HOURS + ' hours, newest first, and what became of it. ' +
    'When they ask whether something went through, answer from THIS list — never from records being missing. ' +
    'WAITING FOR APPROVAL means its card is on their screen. REFUSED and FAILED changes saved NOTHING and will not appear later: ' +
    'say so, say why, and offer to send it again corrected.',
  ];
  list.forEach((r, i) => {
    const outcome = outcomeOf(r);
    const title = clip(r.title || r.summary || 'a change', TITLE_MAX);
    let line = '  ' + (i + 1) + '. ' + outcome + ' — "' + title + '" (' + age(r.created_at, now) + ')';
    if (outcome === 'REFUSED') line += ' — nothing was saved: ' + clip(r.apply_error || 'no reason recorded', REASON_MAX);
    else if (outcome === 'FAILED') line += ' — it did not apply: ' + clip(r.apply_error || 'no reason recorded', REASON_MAX);
    else if (outcome === 'APPLIED' && r.apply_summary) line += ' — ' + clip(r.apply_summary, REASON_MAX);
    lines.push(line);
  });
  lines.push('</recent_writes>');
  return lines.join('\n');
}

module.exports = { recentWritesBlock, outcomeOf, WINDOW_HOURS, MAX_ROWS };
