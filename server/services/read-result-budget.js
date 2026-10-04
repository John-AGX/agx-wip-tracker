'use strict';

/**
 * read-result-budget.js — how a READ TOOL's answer is bounded, and the only
 * place allowed to decide what a bound drops.
 *
 * WHY THIS FILE EXISTS
 *
 * agent-prompt-caps.js bounds the cached PREFIX — paid once per session.
 * This file bounds the other half of the bill: a tool RESULT, paid on the turn
 * that calls the tool and then again on every later turn of that conversation,
 * because a tool result stays in the transcript for the rest of the session.
 * A 100,000-char answer is not a one-time 25,000 tokens; it is 25,000 tokens
 * multiplied by however many turns follow it.
 *
 * read_email_inbox's thread arm had no bound worth the name:
 *
 *   messages        ORDER BY received_at DESC LIMIT 100 — a hard 100-message
 *                   ceiling with nothing said when it bites.
 *   each body       .slice(0, 6000) — per message, so the ceiling is the
 *                   PRODUCT: 100 × 6,000 = 600,000 chars.
 *   attachments     up to 8 per message, .slice(0, 4000) each.
 *
 * ~632,000 chars, ~158,000 tokens, from one tool call, with every cut silent.
 * A long thread did not merely cost a lot — it cost a lot and then reported
 * itself as the whole conversation.
 *
 * WHAT THIS FILE DOES ABOUT IT
 *
 * One budget for the whole answer, spent NEWEST FIRST, because that is the
 * direction the value runs: the last message is what the question is about and
 * the first message is context. A product of per-item caps cannot express
 * that; a shared budget can, and it bounds the total instead of bounding each
 * item and hoping there are few items.
 *
 * WHY THE CUT IS LOUD
 *
 * Same reason as agent-prompt-caps, one step worse. A truncated prompt makes
 * 86 forget something; a truncated RESULT makes 86 confidently wrong — it
 * read "the conversation" and will summarise it as if it had. So every
 * allocation returns a ready-to-print notice naming the count it clipped, the
 * count it omitted, and the way to get the rest. The caller is not trusted to
 * remember: `notice` is built here, and a truncated allocation with no notice
 * printed is a bug in the caller that the tests for each door check for.
 *
 * THE BOUND IS NOT A DEAD END. Every caller of this module must offer a way
 * to read a dropped item in full (read_email_inbox takes `message`). A budget
 * that cannot be reopened is data loss with a friendly message; a budget that
 * can is a cheap default.
 */

// Chars, not tokens — the callers measure chars and Anthropic bills tokens,
// and chars/4 is the estimator used everywhere else in this codebase. Note
// chars/4 UNDERSTATES current tokenizers by 40-60% on prose, so these are
// looser in tokens than they look: 48,000 chars of email is ~17,000 tokens,
// not 12,000.
//
// 48,000 for the thread bodies: a 3-message thread of 6,000-char bodies —
// today's realistic worst case — is unaffected, so this change takes nothing
// away from any conversation 86 reads now. It bites at 8 full messages, where
// the answer is already 12,000+ tokens and the oldest message is no longer
// what anybody asked about.
const THREAD_BODY_BUDGET = 48000;
// Per message, unchanged from the old per-message slice. The budget is the
// new bound; this stays so one enormous message cannot eat a whole thread.
const THREAD_BODY_MAX_PER_MESSAGE = 6000;
// Below this a body is not worth printing — the first 120 chars of an email is
// a greeting. Such a message is reported as OMITTED (and still gets its
// header line, so the shape of the conversation survives) rather than printed
// as a stub that reads like the whole message.
const THREAD_BODY_MIN_SLICE = 600;

// Attachment text gets its own budget rather than sharing the body one, so a
// 40-page PDF cannot silently push the message bodies out of the answer.
const ATTACHMENT_TEXT_BUDGET = 16000;
const ATTACHMENT_TEXT_MAX_PER_FILE = 4000;
const ATTACHMENT_TEXT_MIN_SLICE = 400;

// One message asked for by number may spend much more than its share of a
// thread — that is the whole point of asking for it — but not without limit.
const SINGLE_MESSAGE_BUDGET = 24000;

const toSize = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

/**
 * Spend `budget` chars across `sizes`, newest first.
 *
 * `sizes` is in PRINT order (oldest first, the order the caller will emit).
 * Allocation runs from the END of that array unless `from: 'start'`, so the
 * newest item is served first and the oldest is what runs out. The returned
 * `kept` array is aligned to the INPUT order, so a caller never has to
 * reverse anything — getting that reversal wrong is how a budget silently
 * clips the message somebody asked about.
 *
 * Returns:
 *   kept[]          chars to print for each item, aligned to `sizes`
 *   truncated       true when anything at all was clipped or omitted
 *   clipped         how many items print a PART of themselves
 *   omitted         how many items print NONE of themselves
 *   keptTotal       chars printed
 *   originalTotal   chars available
 *   budget, maxPer, minSlice   the bounds actually applied
 */
function allocate(sizes, opts) {
  const o = opts || {};
  const list = (Array.isArray(sizes) ? sizes : []).map(toSize);
  const budget = Number.isFinite(o.budget) && o.budget >= 0 ? Math.floor(o.budget) : THREAD_BODY_BUDGET;
  const maxPer = Number.isFinite(o.maxPer) && o.maxPer >= 0 ? Math.floor(o.maxPer) : THREAD_BODY_MAX_PER_MESSAGE;
  const minSlice = Number.isFinite(o.minSlice) && o.minSlice >= 0 ? Math.floor(o.minSlice) : THREAD_BODY_MIN_SLICE;
  const fromStart = String(o.from || 'end') === 'start';

  const kept = list.map(() => 0);
  let remaining = budget;
  let clipped = 0;
  let omitted = 0;

  // Indices in ALLOCATION order. Written out rather than reversing `list`
  // in place so `kept` stays aligned to the caller's print order.
  const order = list.map((_, i) => i);
  if (!fromStart) order.reverse();

  for (const i of order) {
    const want = Math.min(list[i], maxPer);
    if (want <= 0) continue;                       // nothing to print anyway
    if (remaining < minSlice || remaining <= 0) {
      omitted += 1;
      continue;
    }
    const give = Math.min(want, remaining);
    kept[i] = give;
    remaining -= give;
    if (give < list[i]) clipped += 1;
  }

  const originalTotal = list.reduce((a, b) => a + b, 0);
  const keptTotal = kept.reduce((a, b) => a + b, 0);
  return {
    kept: kept,
    truncated: clipped > 0 || omitted > 0,
    clipped: clipped,
    omitted: omitted,
    keptTotal: keptTotal,
    originalTotal: originalTotal,
    budget: budget,
    maxPer: maxPer,
    minSlice: minSlice,
  };
}

/**
 * The notice a truncated allocation MUST print, or null when nothing was cut.
 *
 * Says the three things a model needs to not be confidently wrong: that this
 * is not the whole thing, which end is missing, and how to get the rest.
 * `opts.reopen` is that last part and is required — a bound with no way back
 * is data loss, so omitting it is called out in the notice itself rather than
 * quietly left off.
 */
function notice(alloc, opts) {
  const a = alloc || {};
  if (!a.truncated) return null;
  const o = opts || {};
  const noun = o.noun || 'item';
  const plural = o.nounPlural || (noun + 's');
  const bits = [];
  if (a.clipped) bits.push(a.clipped + ' ' + (a.clipped === 1 ? noun : plural) + ' cut short');
  if (a.omitted) bits.push(a.omitted + ' ' + (a.omitted === 1 ? noun : plural) + ' left out entirely');
  const reopen = o.reopen
    ? ' To read one in full: ' + o.reopen
    : ' NO WAY TO READ THE REST IS OFFERED BY THIS TOOL — report that limit if it matters.';
  return '[BUDGETED — THIS IS NOT ALL OF IT: ' + a.originalTotal.toLocaleString('en-US') +
    ' chars available, ' + a.keptTotal.toLocaleString('en-US') + ' kept (' +
    bits.join(', ') + '). Newest first, so what is missing is the OLDEST' +
    (o.whatIsOldest ? ' ' + o.whatIsOldest : '') + '. Do not describe this as the complete ' +
    (o.whole || plural) + '.' + reopen + ']';
}

/**
 * Per-item marker, printed where the item's own text would continue.
 * Returns null for an item that was printed whole.
 */
function itemMarker(keptChars, originalChars, opts) {
  const kept = toSize(keptChars);
  const original = toSize(originalChars);
  if (original <= 0 || kept >= original) return null;
  const o = opts || {};
  if (kept <= 0) {
    return '[' + (o.noun || 'content') + ' left out to stay in budget: ' +
      original.toLocaleString('en-US') + ' chars not shown' +
      (o.reopen ? '. ' + o.reopen : '') + ']';
  }
  return '[cut short: ' + kept.toLocaleString('en-US') + ' of ' +
    original.toLocaleString('en-US') + ' chars' +
    (o.reopen ? '. ' + o.reopen : '') + ']';
}

/**
 * The whole job for one list of texts: allocate, slice, and hand back both the
 * clipped texts and the notice. Callers that need nothing fancier use this and
 * cannot forget the notice, because it comes back in the same object.
 */
function clipTexts(texts, opts) {
  const list = (Array.isArray(texts) ? texts : []).map((t) => (t == null ? '' : String(t)));
  const alloc = allocate(list.map((t) => t.length), opts);
  const o = opts || {};
  const out = list.map((t, i) => {
    const keep = alloc.kept[i];
    const marker = itemMarker(keep, t.length, o);
    return {
      text: keep > 0 ? t.slice(0, keep) : '',
      marker: marker,
      kept: keep,
      original: t.length,
      omitted: t.length > 0 && keep <= 0,
    };
  });
  return { items: out, alloc: alloc, notice: notice(alloc, o) };
}

module.exports = {
  THREAD_BODY_BUDGET,
  THREAD_BODY_MAX_PER_MESSAGE,
  THREAD_BODY_MIN_SLICE,
  ATTACHMENT_TEXT_BUDGET,
  ATTACHMENT_TEXT_MAX_PER_FILE,
  ATTACHMENT_TEXT_MIN_SLICE,
  SINGLE_MESSAGE_BUDGET,
  allocate,
  notice,
  itemMarker,
  clipTexts,
};
