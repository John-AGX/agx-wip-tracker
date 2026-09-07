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
 */
function normalizePhone(raw) {
  const s = (raw == null ? '' : String(raw));
  let d = s.replace(/\D+/g, '');
  if (d.length === 11 && d[0] === '1') d = d.slice(1);
  if (d.length !== 10) return null;
  const area = d.slice(0, 3);
  const exch = d.slice(3, 6);
  if (area[0] === '0' || area[0] === '1') return null;
  if (exch[0] === '0' || exch[0] === '1') return null;
  if (area[1] === '1' && area[2] === '1') return null;
  return '(' + area + ') ' + exch + '-' + d.slice(6);
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
  cleanStoreAddress,
  cleanStoreName,
  agreement,
  SUFFIX_NOISE,
  PREFIX_NOISE,
};
