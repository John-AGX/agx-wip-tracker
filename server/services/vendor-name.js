'use strict';

/**
 * vendor-name.js — THE ONE PLACE A MERCHANT STRING IS MADE SENSE OF.
 *
 * A vendor name reaches P86 as free text from three directions: a QuickBooks
 * payee (`qb_cost_lines.vendor`), a receipt the field crew photographed
 * (`receipts.vendor`), and whatever somebody typed. "HOME DEPOT", "THE HOME
 * DEPOT" and "HOME DEPOT #0242" are one counter. `HD SUPPLY` is a different
 * company — Home Depot sold it in 2007 and bought it back in 2020, separate
 * counter, separate account — and "Home Depot Credit Services" is a card
 * issuer, not a store.
 *
 * ── THE RULE: SUBTRACT NOISE, NEVER GUESS AT SIMILARITY ───────────────────
 * This normalizer only ever REMOVES text that is provably not part of the
 * identity: case, punctuation, an apostrophe, a trailing branch number, and a
 * corporate form word IN THE POSITION WHERE IT IS A CORPORATE FORM WORD. It
 * does not stem, it does not compute edit distance, and it does not decide
 * that two keys are "close enough".
 *
 * The asymmetry is the whole argument. If it SPLITS one counter into two, you
 * see both on the screen and it is one tap to fix. If it MERGES two counters,
 * the spend figure is the sum of two unrelated relationships, silently, with
 * no symptom — the total is just confidently wrong. So: bias to split.
 * A COLLISION IS NOT PERMISSION.
 *
 * ── POSITION MATTERS, AND THIS IS WHERE IT DIFFERS FROM THE TWO CLIENT COPIES
 * js/purchase-order-editor.js:782 (`normCompany`) and js/doc-import.js:591
 * (`_normSub`) both strip `co`, `inc`, `corp` ANYWHERE in the string. That
 * turns "CO Supply" into "supply", "Group Health Partners" into "health
 * partners" and "Holding Bay Lumber" into "bay lumber" — each of which then
 * merges with a genuinely different company. Here a corporate form word is
 * dropped only from the END (where it means "Company"), `the` only from the
 * FRONT, and repeatedly, so "ABC Supply Co Inc" and "ABC Supply" land together
 * while "CO Supply" keeps its own identity.
 *
 * Those two client copies also DISAGREE WITH EACH OTHER (one strips `ltd`, the
 * other strips `enterprises` and `the`) and neither lifts a trailing store
 * number, so `HOME DEPOT #0242` and `THE HOME DEPOT` produce different keys
 * under both. Repointing them at this module is a separate change with its own
 * cache-buster; it is NOT done here, and until it is, this file is the only
 * normalizer any SERVER code may use. Do not write a second one.
 *
 * ── THE EMPTY-KEY TRAP ────────────────────────────────────────────────────
 * Subtractive rules can subtract everything. "The Company" strips to "". If
 * that were the key, every name that happens to strip to nothing would collide
 * into ONE merchant — the exact failure this file is built to prevent, arrived
 * at from the other side. So an empty result falls back to the
 * punctuation-normalized form with nothing dropped.
 */

// Corporate form words, dropped only from the END of the name.
const SUFFIX_NOISE = new Set([
  'llc', 'lc', 'inc', 'incorporated', 'corp', 'corporation', 'co', 'company',
  'companies', 'ltd', 'limited', 'lp', 'llp', 'plc', 'holdings', 'holding',
  'enterprise', 'enterprises', 'group',
]);

// Dropped only from the FRONT.
const PREFIX_NOISE = new Set(['the']);

// A trailing branch token: "#0242", "# 0242", "STORE 0242", "STORE #0242".
// Anchored to the END, because a number in the middle of a name is part of the
// name ("84 Lumber", "4 Seasons Roofing").
const TRAILING_BRANCH = /[\s,\-]*(?:\b(?:store|str|stor)\s*)?#\s*([0-9]{1,6})\s*$/i;
const TRAILING_BRANCH_WORD = /[\s,\-]+\b(?:store|str)\s*#?\s*([0-9]{1,6})\s*$/i;

/**
 * normalizeVendorName('THE HOME DEPOT #0242')
 *   -> { raw, name: 'THE HOME DEPOT', branch: '0242', key: 'home depot' }
 *
 * `key` is the grouping key. `branch` is the store number that was lifted off,
 * or null. `name` is the raw with the branch token removed, otherwise
 * untouched — display always comes from something a human actually wrote.
 */
function normalizeVendorName(raw) {
  const original = (raw == null ? '' : String(raw)).replace(/\s+/g, ' ').trim();
  if (!original) return { raw: '', name: '', branch: null, key: '' };

  let name = original;
  let branch = null;
  let m = TRAILING_BRANCH.exec(name);
  if (!m) m = TRAILING_BRANCH_WORD.exec(name);
  if (m) {
    branch = m[1];
    name = name.slice(0, m.index).trim();
    if (!name) { name = original; branch = null; } // "#0242" alone is not a branch of anything
  }

  // Apostrophes vanish rather than becoming a space: LOWE'S and LOWES are the
  // same word, and turning the apostrophe into a space makes them two.
  const depunctuated = name
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  let words = depunctuated ? depunctuated.split(' ') : [];
  while (words.length > 1 && SUFFIX_NOISE.has(words[words.length - 1])) words.pop();
  while (words.length > 1 && PREFIX_NOISE.has(words[0])) words.shift();
  let key = words.join(' ');

  // THE EMPTY-KEY TRAP, and it does not only fire on the empty string.
  // The loops stop at one word, so "The Company" AND "The Group" both reduce
  // to the single word `the` — two different merchants, one key, merged with
  // no symptom. Whenever everything of substance has been subtracted away,
  // the key falls back to the full punctuation-normalized form with nothing
  // dropped. Splitting is recoverable; merging is not.
  if (!key || (words.length === 1 && (SUFFIX_NOISE.has(key) || PREFIX_NOISE.has(key)))) {
    key = depunctuated;
  }

  return { raw: original, name: name, branch: branch, key: key };
}

/**
 * A store / branch code as printed. Returns an uppercased token or null.
 *
 * Deliberately narrow. On a Home Depot register tape the store number often
 * sits in a run of numbers next to the register and transaction ids
 * (`0242 00012 34567`), so anything that would swallow a neighbour is refused:
 * 9 or more digits is a phone or an account, and a bare empty string is not a
 * branch. The model is instructed to return null rather than pick one out of a
 * row it cannot label, and this is the second line of that defence.
 */
function normalizeStoreNumber(raw) {
  let s = (raw == null ? '' : String(raw)).trim();
  if (!s) return null;
  s = s.replace(/^#+\s*/, '').replace(/^(?:store|str)\s*#?\s*/i, '').trim();
  if (!s) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9\-]{0,7}$/.test(s)) return null;
  if (!/[0-9]/.test(s)) return null;             // a branch code has a number in it
  if (/^[0-9]{9,}$/.test(s)) return null;        // that is a phone or an account, not a branch
  return s.toUpperCase();
}

/**
 * A phone number, or null. NANP-validated, and null is the common answer on
 * purpose: A MISREAD PHONE NUMBER IS WORSE THAN NO PHONE NUMBER. The store
 * phone is small type at the top of a thermal receipt, photographed by someone
 * aiming at the total, then downscaled to 1400px and JPEG-compressed at 0.7.
 * Digits go missing there.
 *
 * These are the rules the numbering plan itself guarantees, so each one
 * removes a class of OCR damage rather than a class of real phone number:
 *   - 10 digits (or 11 with a leading country code 1)
 *   - area code and exchange may not begin with 0 or 1
 *   - the area code may not be N11 (211, 311 ... 911)
 *
 * AND — THE RULE THAT STOPS FABRICATION — THE TEN DIGITS MUST HAVE BEEN
 * PRINTED AS ONE NUMBER. Counting digits is not the same as reading a number,
 * and the difference is not academic:
 *
 *     "282-3400 x407"  ->  digits 2823400407  ->  "(282) 340-0407"
 *
 * Ten digits, NANP-valid in every position, classified 'branch', rendered as a
 * tappable link. NOBODY EVER PRINTED THAT NUMBER. It is a 7-digit local line
 * and its extension spliced end to end, and the area code — the part that says
 * WHICH TOWN you are calling — is invented outright. A receipt prints a local
 * number and its extension the same way on every visit, so the fabrication
 * reads identically on receipt two and earns the corroboration marker.
 *
 * This is worse than a wrong label. A toll-free number reaches the wrong desk
 * at the right company; a spliced extension reaches a stranger, and it does so
 * wearing the green marker that says two receipts agreed.
 *
 * So the digits are no longer merely counted. An extension is split off
 * (which also RECOVERS "(407) 282-3400 x12", previously refused for having 12
 * digits), and what remains must match one contiguous phone-shaped run:
 * optionally +1, then 3-3-4 separated by nothing but spaces, dots, dashes,
 * slashes and parens. A digit run that reaches the count only by jumping a gap
 * the numbering plan does not allow is refused, and 7-digit locals stay
 * refused because an area code cannot be guessed from a receipt.
 */

// Leading and trailing text that carries NO DIGITS cannot change the number,
// so it is dropped rather than made a reason to refuse: "Phone: (407) 282-3400
// (main)" is one number with a label on each end. `+` and `(` are left alone
// at the front because they are part of the number.
const PHONE_LEAD_NOISE = /^[^\d+(]*/;
const PHONE_TAIL_NOISE = /[^\d]*$/;

// An extension, which is not part of the number and on a receipt is printed
// right next to one. `#` is deliberately NOT a token on its own: on a builders'
// merchant receipt `#` means the BRANCH ("HOME DEPOT #0242"), and treating a
// trailing `#407` as an extension would be guessing. It does not need to be —
// the shape test below refuses it either way, because a number and a store
// code separated by a `#` is not one contiguous number.
const PHONE_EXTENSION = /[\s,;]*(?:extension|extn|ext|x)\.?\s*[:#]?\s*\d{1,6}\s*$/i;

// ONE CONTIGUOUS NANP-SHAPED RUN. Separators are only those a printed phone
// number actually uses. A newline is a space here on purpose: a real number
// wrapped across two OCR lines is still that number.
const PHONE_SHAPE = /^\+?[\s.\-/]*1?[\s.\-/]*\(?\d{3}\)?[\s.\-/]*\d{3}[\s.\-/]*\d{4}$/;

function normalizePhone(raw) {
  const s = (raw == null ? '' : String(raw));
  const core = s
    .replace(PHONE_LEAD_NOISE, '')
    .replace(PHONE_TAIL_NOISE, '')
    .replace(PHONE_EXTENSION, '');
  if (!PHONE_SHAPE.test(core)) return null;
  let d = core.replace(/\D+/g, '');
  if (d.length === 11 && d[0] === '1') d = d.slice(1);
  if (d.length !== 10) return null;
  const area = d.slice(0, 3);
  const exch = d.slice(3, 6);
  if (area[0] === '0' || area[0] === '1') return null;
  if (exch[0] === '0' || exch[0] === '1') return null;
  if (area[1] === '1' && area[2] === '1') return null;
  return '(' + area + ') ' + exch + '-' + d.slice(6);
}

// NANP codes that are NOT a place. A geographic area code tells you which
// counter you are calling; none of these do.
//
// The assigned toll-free codes plus the ones the NANP has RESERVED for
// toll-free expansion. The reserved ones are included deliberately: nothing is
// lost by classifying an unassigned code as toll-free, because no branch has a
// number in it, while missing one that gets assigned reopens exactly the hole
// this closes.
const TOLL_FREE_NPA = new Set([
  '800', '833', '844', '855', '866', '877', '888',
  '822', '880', '881', '882', '883', '884', '885', '886', '887', '889',
]);
// Premium rate — the caller is billed by the minute. 900 is an area code; 976
// is the classic premium EXCHANGE, which lives inside an ordinary geographic
// area code, so it has to be checked in the NXX position rather than the NPA.
const PREMIUM_NPA = new Set(['900']);
const PREMIUM_NXX = new Set(['976']);

// A FAX LINE IS A REAL NUMBER AT THAT BRANCH AND IT IS NOT THE ONE ANYONE
// WANTS. It is constant per store, so it corroborates exactly as fast as the
// voice line standing beside it on the same header, and it came out of a
// digits-only classifier looking like the counter's own number.
//
// THE WORD IS THE ONLY EVIDENCE THERE IS. A fax number is a phone number: no
// rule of the numbering plan separates them, no NPA is reserved for them, and
// a fax printed WITHOUT a label is not detectable here and is not claimed to
// be. That limit is real and is pinned as a test rather than left implied.
//
// Read from the RAW string, which is why this function takes the raw and not
// the normalized value — normalizePhone() throws the word away, and after the
// row is written the word is gone for good.
const FAX_LABEL = /\b(?:fax|facsimile)\b/i;

// How much a kind is TRUSTED AS THIS BRANCH'S VOICE LINE, ascending = trusted
// less. Used by phoneKindFloor() so a claim arriving on a request body can
// only ever make a number less trusted.
const PHONE_KIND_RANK = { branch: 0, toll_free: 1, fax: 2, premium: 3 };

/**
 * WHAT KIND OF LINE a number is: 'branch', 'toll_free', 'premium', or null
 * when there is no valid number at all.
 *
 * THIS IS A DIFFERENT QUESTION FROM agreement(), AND THE SEPARATION IS THE
 * WHOLE POINT. agreement() asks "did two independent reads land on the same
 * digits" — a question about OCR. This asks "what did they agree ON" — a
 * question about the phone system. Every rule in normalizePhone() above is a
 * validity rule; not one of them is a store-phone rule, so a corroborated
 * 1-800 number came out the far end looking exactly like a corroborated
 * branch line.
 *
 * The two signals pull in OPPOSITE directions, which is what made this
 * dangerous rather than merely imprecise. A chain's national number is printed
 * on the receipt of EVERY store of that chain, so it agrees perfectly and
 * earns corroboration SOONER AND MORE OFTEN than the branch line it is
 * standing in front of — which differs per store and needs two receipts from
 * the SAME counter before it agrees at all. Ranked by agreement alone, the
 * confidence signal actively promotes the one number that cannot tell you
 * which branch you reached.
 *
 * A toll-free number is not WRONG. It is NOT THIS BRANCH. Some vendors publish
 * nothing else, so it is kept and labelled rather than discarded.
 */
function phoneLineType(raw) {
  const n = normalizePhone(raw);
  if (!n) return null;                            // a bad read stays empty
  const d = n.replace(/[^0-9]+/g, '');
  const area = d.slice(0, 3);
  const exch = d.slice(3, 6);
  // Premium first, and it outranks the fax label: "FAX 1-900-..." is a misread
  // of a geographic number, and there the cost of being wrong is a billed call
  // rather than a wasted one.
  if (PREMIUM_NPA.has(area) || PREMIUM_NXX.has(exch)) return 'premium';
  // Fax before toll-free, because the two differ in what the screen is allowed
  // to do with them: a toll-free number reaches a person and stays tappable, a
  // fax reaches a modem and does not. When a receipt labels a toll-free number
  // as a fax, the more cautious of the two answers is the right one.
  if (FAX_LABEL.test(raw == null ? '' : String(raw))) return 'fax';
  if (TOLL_FREE_NPA.has(area)) return 'toll_free';
  return 'branch';
}

/**
 * The kind to store, given what the DIGITS say and what a request body CLAIMS.
 *
 * THE FAX LABEL IS KNOWABLE FOR ONE INSTANT. It exists in the model's raw
 * output at extraction time and nowhere afterwards — the value the client
 * sends back to be saved is the normalized number, with the word already gone.
 * So the kind has to travel from extraction to save through the client, and a
 * body is a body.
 *
 * It does not have to be TRUSTED, though, only bounded: a claim is honoured
 * only when it trusts the number LESS than the digits alone do. A client may
 * say "this was labelled a fax" about a number the server would otherwise call
 * a branch line; it may not say "branch" about a 1-800 number, or "fax" about
 * a premium-rate one. THE CLAIM CAN REMOVE A LINK. IT CAN NEVER CREATE ONE —
 * which is the only direction that could hurt anybody.
 */
function phoneKindFloor(derived, claimed) {
  const base = derived || null;
  const c = PHONE_KIND_RANK[claimed];
  if (c == null) return base;                     // not a kind we know: ignored
  const d = PHONE_KIND_RANK[base];
  if (d == null) return null;                     // no number at all: no kind
  return c > d ? claimed : base;
}

// Blocks whose presence means the model returned the BUYER'S address. On an
// ABC Supply or White Cap pickup ticket — which is what the field crew
// actually photographs at a branch distributor, not a register tape — the most
// prominent address on the page is AGX's own, under one of these labels. An
// extraction that grabs "the address near the top" captures our own address as
// the vendor's: silently, plausibly, and wrong.
const BUYER_BLOCK = /\b(bill(?:ed)?\s*to|sold\s*to|ship(?:ped)?\s*to|remit\s*to|deliver\s*to|customer)\b/i;

/**
 * A street address for the SELLER, or null.
 *
 * `vendorName` is passed so an "address" that is just the merchant's name
 * again — a common degenerate answer — is refused rather than stored.
 */
function cleanStoreAddress(raw, vendorName) {
  const s = (raw == null ? '' : String(raw)).replace(/\s+/g, ' ').trim();
  if (!s) return null;
  if (s.length < 6 || s.length > 160) return null;
  if (BUYER_BLOCK.test(s)) return null;
  if (!/[0-9]/.test(s)) return null;             // a US street address starts with a number
  if (!/[A-Za-z]{2}/.test(s)) return null;       // and has words in it
  if (vendorName && s.toLowerCase() === String(vendorName).toLowerCase().trim()) return null;
  return s;
}

/**
 * The merchant name as printed. Kept nearly verbatim — this is the one field
 * whose whole job is to record the spelling on the paper — but it is model
 * output that will later be fed back into a prompt as a known-vendor hint, so
 * it is stripped of the characters that would let a photographed receipt
 * reshape this org's own OCR prompt. Same treatment knownVendors() already
 * gives stored vendor strings at receipt-routes.js:454.
 */
function cleanStoreName(raw) {
  // Control characters out, by CODE POINT rather than by regex escape. An
  // earlier spelling of this used a character class and the source file ended
  // up holding the LITERAL bytes, NUL included — see test/no-nul-bytes.test.js.
  const s = String(raw == null ? '' : raw)
    .split('')
    .filter((ch) => { const c = ch.charCodeAt(0); return c >= 32 && c !== 127; })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return null;
  return s.slice(0, 120);
}

/**
 * AGREEMENT ACROSS RECEIPTS IS THE ONLY CONFIDENCE SIGNAL THIS WAVE HAS.
 *
 * The model is NOT asked for a self-reported probability. Vision models are
 * poorly calibrated on that question, and storing the number produces
 * something that looks like evidence and is not. What is real evidence is N
 * independent reads of the same branch landing on the same digits — computed
 * here, server-side, costing the user nothing and requiring no confirmation
 * step that has nowhere to be recorded.
 *
 * Returns:
 *   verdict 'none'         nothing was ever read
 *           'read_once'    one reading, uncorroborated
 *           'agreed'       >= 2 readings, all identical
 *           'conflict'     readings disagree — every variant is returned
 *
 * `values` is always populated when there is anything at all, so a caller
 * cannot render a conflict as a single confident answer by accident.
 */
function agreement(readings) {
  const counts = new Map();
  (readings || []).forEach((v) => {
    if (v == null || v === '') return;
    counts.set(v, (counts.get(v) || 0) + 1);
  });
  const values = [...counts.entries()]
    .map(([value, n]) => ({ value, n }))
    .sort((a, b) => b.n - a.n || String(a.value).localeCompare(String(b.value)));
  const reads = values.reduce((s, v) => s + v.n, 0);
  if (!values.length) return { verdict: 'none', value: null, reads: 0, distinct: 0, values: [] };
  if (values.length > 1) {
    return { verdict: 'conflict', value: null, reads, distinct: values.length, values };
  }
  return {
    verdict: values[0].n >= 2 ? 'agreed' : 'read_once',
    value: values[0].value,
    reads,
    distinct: 1,
    values,
  };
}

module.exports = {
  normalizeVendorName,
  normalizeStoreNumber,
  normalizePhone,
  phoneLineType,
  phoneKindFloor,
  PHONE_KIND_RANK,
  cleanStoreAddress,
  cleanStoreName,
  agreement,
  SUFFIX_NOISE,
  PREFIX_NOISE,
};
