'use strict';

// Proofreading a dictated photo description.
//
// WHY THIS IS SHAPED THE WAY IT IS. Two earlier designs were built and thrown
// away, and the reason is worth keeping in the file, because the obvious
// approach is the one that fails.
//
//   1. Verify the RESULT preserved the meaning, with string checks. 14 of 21
//      realistic corruptions got through. Units were compared as a bag, so
//      "16 LF of drip edge and 8 SF of TPO" -> "16 SF ... 8 LF ..." looked
//      identical.
//   2. PIN the meaning-bearing tokens (numbers, units, negations, directions,
//      trade terms) and require the pin sequence to match. Better — the whole
//      anchor family closed — but 27 of 66 corruptions still got through,
//      because pins protect the ANCHORS and say nothing about the PREDICATE:
//      "the north wall is cracked and the south wall is rotted" with the two
//      predicates swapped has an identical pin sequence AND an identical word
//      multiset.
//
// So this does not ask "did the meaning survive?" — an unbounded question that
// a string check cannot answer. It asks "is every edit the model made drawn
// from a set of edits that cannot change meaning?" That set is finite:
//
//   · punctuation and whitespace          (free: punctuation is not tokenised)
//   · letter case                         (free: tokens are lowercased)
//   · deleting a closed-list filler word
//   · collapsing an exact immediate repetition   ("the soffit the soffit")
//   · substituting a word for its enumerated mis-hearing correction, ONE WAY
//
// Anything else — a content word in or out, a reordering, a substitution
// outside the map — is a rewrite, and a rewrite is refused. The user keeps his
// own words and is told what the model tried to change.
//
// One carve-out the pin design earned by failing: punctuation is free EXCEPT
// that a sentence boundary may not be inserted immediately after a negation.
// "no active leak at the valley metal" -> "No. Active leak at the valley
// metal." has identical tokens, identical punctuation-stripped everything, and
// the opposite meaning — and splitting an unpunctuated run-on is the single
// edit the prompt most encourages, on input that is always an unpunctuated
// run-on.

const { Anthropic } = require('@anthropic-ai/sdk');

// Same model id as the other four Haiku call sites in this repo
// (attachment-ocr, email-triage, doc-import-routes, receipt-routes).
const TIDY_MODEL = 'claude-haiku-4-5';

const MAX_CAPTION = 2000; // matches the upload path's cap (attachment-routes)

let _anth = null;
function client() {
  if (_anth) return _anth;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  _anth = new Anthropic({ apiKey: key });
  return _anth;
}

// ── the licensed edit set ────────────────────────────────────────────────

// Single words a proofread may delete. Deliberately closed and deliberately
// short: every word here is one that carries no content in a dictated
// sentence. "really", "very", "about" are NOT here — they modify meaning.
const FILLER = new Set([
  'um', 'umm', 'uh', 'uhh', 'uhm', 'er', 'erm', 'ah', 'ahh', 'hmm',
  'like', 'basically', 'literally', 'honestly', 'obviously', 'anyway',
  'okay', 'ok', 'alright', 'so', 'well', 'just', 'kinda', 'sorta',
]);

// Multi-word fillers, matched as a whole run.
const FILLER_PHRASES = new Set([
  'you know', 'i mean', 'sort of', 'kind of', 'you know what i mean',
  'let me see', 'let us see', 'lets see',
]);

// Enumerated speech-to-text mis-hearings, applied ONE WAY ONLY: the key may
// become the value, never the reverse. Direction is the whole point — a model
// turning "typo" into "TPO" is fixing a transcription error; a model turning
// "TPO" into "typo" is corrupting a roofing spec, and a two-way map cannot
// tell those apart. (That was a real defect in the pin design: it normalised
// both sides and went blind to the corruption.)
const MISHEARING = new Map(Object.entries({
  sofa: 'soffit', sofit: 'soffit', soffet: 'soffit', 'soft fit': 'soffit',
  facia: 'fascia', fascio: 'fascia', 'fash ya': 'fascia',
  typo: 'tpo', 'tea po': 'tpo', 'tee po': 'tpo',
  parapit: 'parapet', parapent: 'parapet', 'para pet': 'parapet',
  copping: 'coping', 'cope ing': 'coping',
  'drip ledge': 'drip edge', 'drip hedge': 'drip edge',
  'r and r': 'r&r', 'are and are': 'r&r',
  lenai: 'lanai', 'la nai': 'lanai',
  stuko: 'stucco', stucko: 'stucco',
  flashings: 'flashing',
  'down spout': 'downspout', 'down spouts': 'downspouts',
  'j channel': 'j-channel',
  'hardy board': 'hardie board', 'hardi board': 'hardie board',
  'ridge event': 'ridge vent', 'ridge events': 'ridge vents',
}));

// Negation and polarity. A sentence boundary may not be inserted right after
// one of these, and none of them may be deleted or introduced.
const NEGATION = new Set([
  'no', 'not', 'never', 'none', 'nothing', 'nobody', 'nowhere', 'nor',
  'neither', 'without', 'cannot', 'cant', 'wont', 'dont', 'doesnt', 'didnt',
  'isnt', 'arent', 'wasnt', 'werent', 'hasnt', 'havent', 'hadnt', 'shouldnt',
  'couldnt', 'wouldnt', 'lacks', 'lacking', 'missing', 'absent',
]);

// Belt and braces on top of the licensed-edit check: these must survive
// byte-for-byte as an ordered sequence. The licensed set already forbids
// touching them, so this is a second, independent way to notice.
const UNIT = new Set([
  'lf', 'sf', 'sy', 'cy', 'ea', 'sq', 'mil', 'ga', 'oc', 'psi', 'gal', 'lb',
  'yd', 'cf', 'amp', 'volt', 'hr', 'pc', 'bdl', 'ft', 'in', 'foot', 'feet',
  'inch', 'inches', 'yard', 'yards', 'square', 'squares', 'bundle', 'bundles',
  'sheet', 'sheets', 'roll', 'rolls', 'gauge', 'course', 'courses',
]);

const NUMBER_WORD = new Set([
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight',
  'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen',
  'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty', 'thirty', 'forty',
  'fifty', 'sixty', 'seventy', 'eighty', 'ninety', 'hundred', 'thousand',
  'half', 'quarter', 'third', 'dozen',
]);

// ── tokenising ───────────────────────────────────────────────────────────

// A token is a lowercased word. Punctuation and whitespace vanish here, which
// is exactly what makes "insert a comma" and "capitalise the sentence" free
// without a rule of their own. Apostrophes inside a word are dropped so
// "isn't" and "isnt" are one token; & is kept so R&R survives as one.
function tokens(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[‘’']/g, '')
    .split(/[^a-z0-9&]+/)
    .filter(Boolean);
}

// The ordered sequence of things that must never move: every digit run, every
// spelled-out number, every unit word, and every foot/inch mark that follows a
// digit. Compared as a SEQUENCE, not a set — a bag cannot see a unit
// re-attached to a different number.
function anchors(text) {
  const out = [];
  const src = String(text || '').toLowerCase();
  const re = /(\d+(?:\.\d+)?)|([a-z][a-z&-]*)|(['"])/g;
  let m;
  let lastWasDigit = false;
  while ((m = re.exec(src))) {
    if (m[1] != null) { out.push('n:' + m[1]); lastWasDigit = true; continue; }
    if (m[2] != null) {
      const w = m[2];
      if (UNIT.has(w)) out.push('u:' + w);
      else if (NUMBER_WORD.has(w)) out.push('n:' + w);
      lastWasDigit = false;
      continue;
    }
    if (m[3] != null && lastWasDigit) { out.push('u:' + m[3]); }
    lastWasDigit = false;
  }
  return out;
}

// ── diff ─────────────────────────────────────────────────────────────────

// Longest common subsequence over tokens, then the ops grouped into hunks of
// { del: [...], ins: [...] } so a hunk can be judged as a whole (a multi-word
// filler, a stammer run, a multi-word mis-hearing).
function hunks(a, b) {
  const n = a.length, m = b.length;
  const L = [];
  for (let i = 0; i <= n; i++) L.push(new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0, cur = null;
  const flush = () => { if (cur) { out.push(cur); cur = null; } };
  while (i < n && j < m) {
    if (a[i] === b[j]) { flush(); i++; j++; continue; }
    if (!cur) cur = { del: [], ins: [], at: i };
    if (L[i + 1][j] >= L[i][j + 1]) { cur.del.push(a[i++]); }
    else { cur.ins.push(b[j++]); }
  }
  if (i < n || j < m) {
    if (!cur) cur = { del: [], ins: [], at: i };
    while (i < n) cur.del.push(a[i++]);
    while (j < m) cur.ins.push(b[j++]);
  }
  flush();
  return out;
}

// Is this deleted run an exact immediate repetition of what sits beside it?
// "the soffit the soffit is rotted" -> deleting the first "the soffit" is
// licensed because the next two tokens are the same two tokens.
function isStammer(orig, at, run) {
  if (!run.length) return false;
  const after = orig.slice(at + run.length, at + run.length * 2);
  if (after.length === run.length && after.every((t, k) => t === run[k])) return true;
  const before = orig.slice(Math.max(0, at - run.length), at);
  if (before.length === run.length && before.every((t, k) => t === run[k])) return true;
  return false;
}

// Apply the mis-hearing map to the ORIGINAL only, longest phrase first, so a
// correction the model is allowed to make simply disappears from the diff.
// Doing it here rather than per-hunk matters for two adjacent corrections
// ("facia r and r" -> "fascia R&R"), which the aligner merges into one hunk
// that no single map entry can explain.
//
// ONE-WAY, AND THAT IS THE POINT: the map is never applied to the model's
// reply. "typo" -> "TPO" vanishes because the original canonicalises to the
// same thing; "TPO" -> "typo" survives as a hunk and is refused. A design that
// normalised both sides went blind to exactly that corruption.
const MISHEARING_PHRASES = Array.from(MISHEARING.keys()).sort((a, b) => b.length - a.length);

function canonicalize(text) {
  let s = ' ' + String(text || '') + ' ';
  for (const key of MISHEARING_PHRASES) {
    const re = new RegExp('(^|[^a-z0-9&])' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![a-z0-9&])', 'gi');
    s = s.replace(re, (m, pre) => pre + MISHEARING.get(key));
  }
  return s.trim();
}

function licenseHunk(h, orig) {
  const del = h.del, ins = h.ins;

  // Pure insertion of words. Never licensed — a proofread does not add content.
  if (!del.length) return { ok: false, why: 'added "' + ins.join(' ') + '"' };

  // Pure deletion. Licensed as filler, as a filler phrase, or as a stammer.
  if (!ins.length) {
    if (del.every((t) => FILLER.has(t))) return { ok: true };
    if (FILLER_PHRASES.has(del.join(' '))) return { ok: true };
    if (isStammer(orig, h.at, del)) return { ok: true };
    return { ok: false, why: 'removed "' + del.join(' ') + '"' };
  }

  // Substitution. Licensed only as an enumerated mis-hearing, one way.
  const d = del.join(' '), s = ins.join(' ');
  if (MISHEARING.get(d) === s) return { ok: true };
  // A stammer whose surviving copy was itself mis-heard: "sofa sofa" -> "soffit".
  if (isStammer(orig, h.at, del) && MISHEARING.get(del[0]) === s) return { ok: true };
  return { ok: false, why: 'changed "' + d + '" to "' + s + '"' };
}

// A sentence boundary immediately after a negation inverts the sentence while
// leaving every token, every anchor and every count identical.
function splitsANegation(after) {
  const re = /\b([a-z]+)\s*[.!?;]+\s+/gi;
  let m;
  while ((m = re.exec(String(after || '')))) {
    const w = m[1].toLowerCase().replace(/[‘’']/g, '');
    if (NEGATION.has(w)) return w;
  }
  return null;
}

/**
 * Decide whether `after` is a legitimate proofread of `before`.
 * Returns { ok: true } or { ok: false, reason, detail }.
 */
function verifyTidy(rawBefore, after) {
  const before = canonicalize(rawBefore);
  const a = tokens(before), b = tokens(after);

  if (!b.length && a.length) {
    return { ok: false, reason: 'empty', detail: 'it came back empty' };
  }

  const neg = splitsANegation(after);
  if (neg && !splitsANegation(before)) {
    return {
      ok: false,
      reason: 'negation-split',
      detail: 'it ended a sentence right after "' + neg + '", which flips what the sentence says',
    };
  }

  const ha = anchors(before), hb = anchors(after);
  if (ha.length !== hb.length || ha.some((t, k) => t !== hb[k])) {
    return {
      ok: false,
      reason: 'measurement-moved',
      detail: 'a number or unit changed (' + ha.join(' ') + ' became ' + hb.join(' ') + ')',
    };
  }

  for (const h of hunks(a, b)) {
    const v = licenseHunk(h, a);
    if (!v.ok) return { ok: false, reason: 'rewrite', detail: 'it ' + v.why };
  }

  return { ok: true };
}

// ── the model call ───────────────────────────────────────────────────────

const SYSTEM_PROMPT = [
  'You are proofreading one photo description dictated aloud by a field supervisor at an exterior-construction company in Central Florida — roofing, stucco, soffit and fascia, painting.',
  '',
  'You may make ONLY these changes:',
  '1. Add or fix punctuation and capitalisation. Break a run-on into sentences.',
  '2. Delete filler: um, uh, like, basically, you know, I mean, so, well, just, kind of, sort of.',
  '3. Collapse a stammer — a phrase transcribed twice in a row ("the soffit the soffit is rotted") is ONE statement. Keep it once.',
  '4. Fix obvious speech-to-text mis-hearings of trade words: "sofa" is soffit, "facia" is fascia, "typo" is TPO, "r and r" is R&R, "drip ledge" is drip edge, "copping" is coping, "parapit" is parapet.',
  '',
  'You may NOT:',
  '· add any word that carries meaning, or any clause, or a closing summary',
  '· remove any word that carries meaning',
  '· reword, rephrase, or reorder anything',
  '· change any number, measurement, unit, address, building or lot number',
  '· change or move a negative — "not", "no", "never" stay exactly where they are, attached to exactly what they were attached to',
  '· change a direction — north, south, above, below, upper, lower, left, right',
  '· change what is asserted: if he says the inspector approved it, it stays approved',
  '',
  'If the text is already clean, return it unchanged. Never explain, never apologise, never add a preamble.',
  '',
  'Return ONLY the corrected description.',
].join('\n');

/**
 * Proofread a dictated caption. Never writes anything.
 * Resolves { ok: true, text, changed } or { ok: false, reason, detail }.
 */
async function tidyCaption(raw) {
  const before = String(raw == null ? '' : raw);
  const trimmed = before.trim();

  if (!trimmed) return { ok: false, reason: 'empty-input', detail: 'there is nothing in the description yet' };
  if (trimmed.split(/\s+/).length < 3) {
    return { ok: false, reason: 'too-short', detail: 'there is not enough there to clean up' };
  }
  if (before.length > MAX_CAPTION) {
    return { ok: false, reason: 'too-long', detail: 'that description is longer than ' + MAX_CAPTION + ' characters' };
  }

  const anth = client();
  if (!anth) return { ok: false, reason: 'unavailable', detail: 'the cleanup service is not configured on this deployment' };

  let reply;
  try {
    const msg = await anth.messages.create({
      model: TIDY_MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: trimmed }],
    });
    reply = (msg && Array.isArray(msg.content) ? msg.content : [])
      .filter((c) => c && c.type === 'text')
      .map((c) => c.text)
      .join('')
      .trim();
  } catch (e) {
    return { ok: false, reason: 'call-failed', detail: 'the cleanup service did not answer' };
  }

  if (!reply) return { ok: false, reason: 'empty', detail: 'it came back empty' };
  if (reply.length > MAX_CAPTION) {
    return { ok: false, reason: 'too-long', detail: 'the cleaned-up version was too long to save' };
  }

  const verdict = verifyTidy(trimmed, reply);
  if (!verdict.ok) return { ok: false, reason: verdict.reason, detail: verdict.detail };

  return { ok: true, text: reply, changed: reply !== trimmed };
}

module.exports = {
  tidyCaption,
  canonicalize,
  verifyTidy,
  // exported for the tests
  tokens,
  anchors,
  hunks,
  splitsANegation,
  TIDY_MODEL,
  MAX_CAPTION,
  SYSTEM_PROMPT,
  _setClientForTest: (c) => { _anth = c; },
};
