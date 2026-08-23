'use strict';

/**
 * agent-prompt-caps.js — bounds on the two per-tenant blocks that
 * composedAgentSystem() appends to the registered agent system prompt,
 * and the only place allowed to apply them.
 *
 * WHY THIS FILE EXISTS
 *
 * The registered system prompt is the CACHED PREFIX. Every session on the
 * agent pays for it on its first turn via cache_read, and pays for it AGAIN
 * as cache_creation every time the cache entry lapses. It is not paid once —
 * it is paid per session, forever, by every user in the org.
 *
 * Two of its parts had no bound at all:
 *
 *   org_memory        SELECT name, body FROM org_memory WHERE organization_id=$1
 *                     AND archived_at IS NULL — no LIMIT, no length cap, every
 *                     row in full.
 *   identity_body     organizations.identity_body, appended whole.
 *
 * Today they are 6,536 and 1,132 chars — small. That is not a defense; it is
 * a coincidence of what has been typed into them so far. Both are free-text
 * admin fields. One pasted spec document in org_memory and the largest line
 * in the prompt ledger is a document nobody remembers pasting, billed to
 * every session in the tenant.
 *
 * The reference-links block already learned this lesson (REF_LINKS_PROMPT_CAP,
 * 60,000 chars, in admin-agents-routes.js). These two never did.
 *
 * WHY THE TRUNCATION IS LOUD
 *
 * A silently truncated memory block means 86 quietly stops knowing something
 * and nobody is told — the exact failure agent-tool-description.js was written
 * to make impossible for tool descriptions. The tail-cut is not neutral about
 * WHAT it deletes: org_memory is ordered by sort_order then created_at, so a
 * tail-cut deletes the rows added MOST RECENTLY — the newest posture the org
 * wrote down is the first thing to disappear.
 *
 * So truncation here is reported three ways:
 *   1. IN THE PROMPT — a notice block naming the dropped rows by name, so the
 *      model itself knows its posture is partial and can say so.
 *   2. IN THE AUDIT — structured counts on the return value, surfaced by
 *      /api/admin/agents/managed/prompt-audit.
 *   3. IN THE LOG — a ready-to-log `warning` string, same contract as
 *      capToolDescription.
 *
 * The fix for an over-cap block is NEVER to raise the cap. Archive the rows
 * that are no longer posture, or move reference material into a reference
 * link with inject_mode='lookup' so 86 fetches it on demand instead of
 * carrying it on every session of every user.
 */

// Chars, not tokens — the callers measure chars and Anthropic bills tokens,
// and chars/4 is the estimator used everywhere else in this codebase.
//
// Both caps are set WELL above today's content on purpose: this change must
// not remove anything 86 currently knows. At the values below, the live AGX
// org (6,536 / 1,132 chars) truncates nothing. They exist to bound the blast
// radius of a future paste, not to trim what is already there.
const ORG_MEMORY_PROMPT_CAP = 24000;      // ~6,000 tokens
const IDENTITY_BODY_PROMPT_CAP = 8000;    // ~2,000 tokens

// The in-prompt truncation notice is itself bounded, so the total can never
// exceed the cap no matter how many rows were dropped or how long their names
// are. Reserved out of the cap up front — the kept content is fitted into
// (cap - NOTICE_RESERVE), then the notice is built and clamped to
// NOTICE_RESERVE. That makes `text.length <= cap` an arithmetic guarantee
// rather than something the caller has to check.
const NOTICE_RESERVE = 700;

// Clamp the notice to the reserve AND to the cap itself. The second bound is
// what makes `text.length <= cap` hold for a pathologically small cap — a
// caller passing cap=100 must still get 100 chars, not a 700-char notice.
function _clampNotice(s, capChars) {
  const limit = Math.max(0, Math.min(NOTICE_RESERVE, capChars));
  const t = String(s || '');
  if (t.length <= limit) return t;
  return limit > 0 ? t.slice(0, limit - 1) + '…' : '';
}

/**
 * Cap organizations.identity_body.
 *
 * Returns { text, truncated, originalChars, keptChars, droppedChars,
 *           cap, warning }.
 * `text` is always <= cap. `warning` is a ready-to-log string when
 * truncation happened, else null.
 */
function capIdentityBody(body, cap) {
  // A cap of 0 means ZERO, not "use the default". Treating a falsy-but-real
  // bound as absent is how a cap gets quietly bypassed — the same class of
  // defect this file exists to close.
  const capChars = Number.isFinite(cap) && cap >= 0 ? Math.floor(cap) : IDENTITY_BODY_PROMPT_CAP;
  const raw = (body == null ? '' : String(body)).trim();
  if (raw.length <= capChars) {
    return {
      text: raw,
      truncated: false,
      originalChars: raw.length,
      keptChars: raw.length,
      droppedChars: 0,
      cap: capChars,
      warning: null,
    };
  }
  const notice = _clampNotice(
    '\n\n[TRUNCATED: this organization identity is ' + raw.length + ' chars, ' +
    (raw.length - capChars) + ' over the ' + capChars + '-char prompt cap. The TAIL was cut — ' +
    'whatever was written LAST is not in this prompt. Say so if asked about org identity.]',
    capChars
  );
  const keep = Math.max(0, capChars - notice.length);
  const text = raw.slice(0, keep) + notice;
  return {
    text: text,
    truncated: true,
    originalChars: raw.length,
    keptChars: keep,
    droppedChars: raw.length - keep,
    cap: capChars,
    warning:
      '[agents] ORG IDENTITY TRUNCATED: organizations.identity_body is ' + raw.length +
      ' chars, ' + (raw.length - capChars) + ' over the ' + capChars + '-char prompt cap. ' +
      'This block is in the CACHED PREFIX — every session in the org pays it. The TAIL is ' +
      'cut, so whatever was written LAST is INVISIBLE to 86. Shorten identity_body; do NOT ' +
      'raise the cap.',
  };
}

/**
 * Build the "## Working posture" block from org_memory rows, capped.
 *
 * Rows are dropped WHOLE, from the tail, in the order given (the caller
 * orders by sort_order ASC, created_at ASC) — a half-row of posture is worse
 * than no row. The one exception is a single row that alone exceeds the
 * budget: it is hard-cut with an inline marker, because dropping it entirely
 * would leave the block empty and say nothing about why.
 *
 * Returns { text, truncated, rowsGiven, rowsKept, droppedNames,
 *           originalChars, keptChars, cap, warning }.
 * `text` is always <= cap, and is '' when there are no rows.
 */
function buildOrgMemoryBlock(rows, cap) {
  // Same rule as capIdentityBody: 0 means 0.
  const capChars = Number.isFinite(cap) && cap >= 0 ? Math.floor(cap) : ORG_MEMORY_PROMPT_CAP;
  const list = Array.isArray(rows) ? rows : [];
  const empty = {
    text: '', truncated: false, rowsGiven: list.length, rowsKept: 0,
    droppedNames: [], originalChars: 0, keptChars: 0, cap: capChars, warning: null,
  };
  if (!list.length) return empty;

  const HEADER = '## Working posture';
  const chunks = list.map(function (r) {
    const name = String((r && r.name) != null ? r.name : '').trim();
    const body = String((r && r.body) != null ? r.body : '').trim();
    return { name: name || '(unnamed)', text: '### ' + (name || '(unnamed)') + '\n' + body };
  });

  const full = [HEADER].concat(chunks.map(function (c) { return c.text; })).join('\n\n');
  if (full.length <= capChars) {
    return {
      text: full, truncated: false, rowsGiven: list.length, rowsKept: list.length,
      droppedNames: [], originalChars: full.length, keptChars: full.length,
      cap: capChars, warning: null,
    };
  }

  // Over cap. Fit whole rows into (cap - NOTICE_RESERVE), then spend at most
  // NOTICE_RESERVE telling the model what it lost.
  // NOTICE_RESERVE for the notice, +2 for the '\n\n' that joins it to the
  // kept rows. Reserving both is what makes the <= cap bound exact rather
  // than off-by-the-separator.
  const budget = Math.max(0, capChars - NOTICE_RESERVE - 2);
  const kept = [];
  const droppedNames = [];
  let used = HEADER.length;
  let hardCutRow = null;
  for (let i = 0; i < chunks.length; i++) {
    const add = 2 + chunks[i].text.length; // the '\n\n' separator + the chunk itself
    if (used + add <= budget) {
      kept.push(chunks[i].text);
      used += add;
      continue;
    }
    // First row that does not fit. If NOTHING has been kept yet, this single
    // row is bigger than the whole budget — hard-cut it rather than emit a
    // block with no posture in it at all.
    if (!kept.length && hardCutRow === null) {
      const room = Math.max(0, budget - used - 2);
      const marker = '\n[…row cut at the prompt cap…]';
      if (room > marker.length + 20) {
        kept.push(chunks[i].text.slice(0, room - marker.length) + marker);
        used = budget;
        hardCutRow = chunks[i].name;
        continue;
      }
    }
    droppedNames.push(chunks[i].name);
  }

  const shownNames = [];
  let namesLen = 0;
  for (const n of droppedNames) {
    if (namesLen + n.length + 2 > 300) break;
    shownNames.push(n);
    namesLen += n.length + 2;
  }
  const moreCount = droppedNames.length - shownNames.length;
  const notice = _clampNotice(
    '## Working posture — TRUNCATED\n' +
    'This posture block hit the ' + capChars + '-char prompt cap. ' +
    droppedNames.length + ' of ' + list.length + ' memory rows are NOT in this prompt' +
    (shownNames.length
      ? ': ' + shownNames.join(', ') + (moreCount > 0 ? ', and ' + moreCount + ' more' : '')
      : '') + '. ' +
    (hardCutRow ? 'The row "' + hardCutRow + '" is itself cut short. ' : '') +
    'You do NOT have the org posture those rows carry — if a question turns on them, say ' +
    'your working posture is truncated and ask, rather than guessing.',
    capChars
  );

  const text = (kept.length ? [HEADER].concat(kept).join('\n\n') + '\n\n' : '') + notice;
  return {
    text: text,
    truncated: true,
    rowsGiven: list.length,
    rowsKept: kept.length,
    droppedNames: droppedNames,
    originalChars: full.length,
    keptChars: text.length,
    cap: capChars,
    warning:
      '[agents] ORG MEMORY TRUNCATED: the org_memory block is ' + full.length + ' chars, ' +
      (full.length - capChars) + ' over the ' + capChars + '-char prompt cap. ' +
      droppedNames.length + ' of ' + list.length + ' rows were DROPPED from the registered ' +
      'system prompt' + (shownNames.length ? ' (' + shownNames.join(', ') +
      (moreCount > 0 ? ', +' + moreCount + ' more' : '') + ')' : '') + '. ' +
      'Rows are ordered sort_order, created_at — so the TAIL that is cut is the posture ' +
      'added MOST RECENTLY. This block is in the CACHED PREFIX: every session in the org ' +
      'pays for it. Archive rows that are no longer posture, or move reference material to ' +
      "a reference link with inject_mode='lookup'; do NOT raise the cap.",
  };
}

module.exports = {
  ORG_MEMORY_PROMPT_CAP,
  IDENTITY_BODY_PROMPT_CAP,
  NOTICE_RESERVE,
  capIdentityBody,
  buildOrgMemoryBlock,
};
