'use strict';
// ── BUILDERTREND → PROJECT 86 MATCHER + PROPOSED CORRECTIONS (PURE, NO I/O) ──
//
// DIRECTION OF TRUTH, decided by the owner: Buildertrend is the source of truth.
// A difference is therefore a PROPOSED CORRECTION — field, what P86 has now,
// what P86 would become. This module only PROPOSES; nothing that calls it writes.
//
// THE STANDING LIMITS, each enforced below and executed by
// test/clickr-sync-preview.test.js:
//   1. A Buildertrend BLANK never erases a P86 value. '', null, whitespace,
//      '--', '—', 'n/a', 'Unassigned', 'TBD', and 0 for money/confidence are
//      collected in `btBlank`, never proposed.
//   2. Only fields Buildertrend CARRIES are proposed — jobs: title, street,
//      city, state, zip, status, projected start; leads: title, address,
//      salesperson, contact->client, source, confidence.
//   3. MONEY is never proposed. Contract price, approved CO price and lead
//      revenue go in `heldBack` with BOTH figures. An unparseable non-empty
//      money value is held back as "unparsed", never read as blank. The job
//      NUMBER is held back too: it is P86's identity and the QuickBooks import key.
//   4. An AMBIGUOUS match proposes nothing, and every candidate it had is listed.
//   5. P86 records no Buildertrend row reached are for REVIEW, never deletion.
//   6. A Buildertrend typo is still Buildertrend's value ("Tamp" is what P86
//      would receive), flagged so it is fixed in Buildertrend.
//
// ── THE CLASSES ──────────────────────────────────────────────────────────
//   matched            one confident counterpart, nothing to correct
//   conflict           one confident counterpart, at least one correction
//   ambiguous          more than one plausible counterpart, or one that a
//                      guard refuses (reused number, number written
//                      differently, weak rung). Proposes nothing.
//   possible_duplicate no counterpart on any exact rung, but a NEAR one (a
//                      similar name, or the same street with a typo'd city).
//                      Review — never "would be created".
//   new                no counterpart on any rung ("would be created in P86")
//   change_order       (jobs) a "(CO<n>)" row: maps to a P86 change order on
//                      its parent, never a job
//   not_a_job          (jobs) no job number at the front of the name
//                      ("General", "Pre-sale"): a Buildertrend bucket
//   refused            no name at all (or deleted in Buildertrend): cannot be
//                      matched and is never created
// Only matched/conflict/ambiguous/possible_duplicate/new count toward the match rate.

// ── normalisers ──────────────────────────────────────────────────────────

function str(v) {
  return v == null ? '' : String(v);
}

const BLANK_WORDS = new Set(['n/a', 'unassigned', 'tbd']);

// BLANK on the Buildertrend side: unknown, never a value.
function isBtBlank(v) {
  if (v == null) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'number') return false;
  if (typeof v !== 'string') return false;
  const s = v.trim();
  if (s === '') return true;
  if (/^[-–—]+$/.test(s)) return true;
  return BLANK_WORDS.has(s.toLowerCase());
}

// Blank on the P86 side is plain emptiness — P86 placeholders are values.
function isP86Blank(v) {
  return v == null || String(v).trim() === '';
}

function textKey(v) {
  return str(v)
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const STREET_WORDS = {
  street: 'st', avenue: 'ave', av: 'ave', drive: 'dr', road: 'rd', boulevard: 'blvd', lane: 'ln',
  court: 'ct', circle: 'cir', parkway: 'pkwy', place: 'pl', terrace: 'ter', highway: 'hwy',
  trail: 'trl', square: 'sq', north: 'n', south: 's', east: 'e', west: 'w',
  northeast: 'ne', northwest: 'nw', southeast: 'se', southwest: 'sw', suite: 'ste', apartment: 'apt',
};

function streetKey(v) {
  const t = textKey(v);
  if (!t) return '';
  return t.split(' ').map((w) => STREET_WORDS[w] || w).join(' ');
}

function cityKey(v) {
  return textKey(v).replace(/^saint /, 'st ');
}

function stateKey(v) {
  return textKey(v).replace(/\s+/g, '').toUpperCase();
}

function zipKey(v) {
  const m = str(v).match(/\b(\d{5})(?:-\d{4})?\b/);
  return m ? m[1] : '';
}

// Optimal-string-alignment distance (Levenshtein + adjacent transposition).
function osa(a, b) {
  const n = a.length;
  const m = b.length;
  if (!n) return m;
  if (!m) return n;
  const d = [];
  for (let i = 0; i <= n; i++) { d[i] = [i]; }
  for (let j = 0; j <= m; j++) d[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[n][m];
}

// Equal, or a small typo apart. Short strings get no tolerance at all — "FL"
// and "CO" are one edit apart and are different states.
function fuzzyEq(a, b) {
  if (a === b) return true;
  const min = Math.min(a.length, b.length);
  if (min < 4) return false;
  return osa(a, b) <= (Math.max(a.length, b.length) >= 10 ? 2 : 1);
}

// A calendar DATE, read by its written Y-M-D and never shifted through a
// timezone: "2025-02-03T05:00:00.000Z" is the day 2025-02-03.
function dateKey(v) {
  const s = str(v).trim();
  if (!s) return '';
  const pad = (n) => String(n).padStart(2, '0');
  const ok = (y, mo, d) => (y >= 1990 && y <= 2100 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31) ? y + '-' + pad(mo) + '-' + pad(d) : '';
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:$|[T\s])/);
  if (m) return ok(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return ok(+m[3], +m[1], +m[2]);
  return '';
}

const STOP = new Set(['and', 'the', 'of', 'at', 'for', 'to', 'in', 'on']);
function tokens(s) {
  return new Set(textKey(s).split(' ').filter((w) => w.length > 1 && !STOP.has(w)));
}

function bigrams(s) {
  const t = textKey(s).replace(/ /g, '');
  const m = new Map();
  for (let i = 0; i < t.length - 1; i++) { const g = t.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1); }
  return m;
}
// Character-bigram Dice coefficient: survives a one-letter typo that token
// overlap does not ("Replacment" vs "Replacement").
function charSimilarity(a, b) {
  const A = typeof a === 'string' ? bigrams(a) : a;
  const B = typeof b === 'string' ? bigrams(b) : b;
  let na = 0; let nb = 0; let inter = 0;
  for (const v of A.values()) na += v;
  for (const v of B.values()) nb += v;
  if (!na || !nb) return 0;
  for (const [g, v] of A) inter += Math.min(v, B.get(g) || 0);
  return (2 * inter) / (na + nb);
}

// Trade words and other words that say WHAT the work is, not WHICH job it is.
// Two names that share only these do not identify the same job: "Exterior
// Paint" is not "Waterside Exterior Paint & Repairs". Pure numbers are generic
// too ("Bldg 12" is not "Unit 12").
const GENERIC = new Set(('exterior interior ext int paint painting repaint repaints repair repairs replacement replacements replace '
  + 'roof roofing reroof siding deck decks stair stairs staircase railing railings rail rails gate gates fence fencing pool screen '
  + 'enclosure enclosures service services call residential commercial stucco gutter gutters pressure washing wash building buildings '
  + 'bldg annual maintenance install installation window windows door doors leak leaks work project job renovation remodel restoration '
  + 'waterproofing sealant caulking concrete pavers paver flat hatch sliding entrance monument balcony balconies framing drywall '
  + 'carpentry wood rot inspection estimate phase new misc general small large full partial common area areas unit units office home '
  + 'house exteriors interiors coating coatings patch patching trim soffit fascia shutters shutter lanai screens').split(' '));

function distinctive(s) {
  const out = new Set();
  for (const w of tokens(s)) if (!GENERIC.has(w) && !/^\d+$/.test(w)) out.add(w);
  return out;
}

// How two names bear on "is this the same job/lead?":
//   'unknown'  — either side has no name
//   'agree'    — the names overlap AND share a distinctive word (typo-tolerant)
//   'weak'     — the same generic name on both sides ("Roof Repair" / "Roof Repair"):
//                it cannot tell two jobs apart, so it counts as unknown
//   'disagree' — anything else, including overlap made only of generic words
// Bounded on purpose: one shared word is not agreement ("Pool" vs "Hannah Pool
// Screen Enclosure"), and a containment only counts when the shorter name has at
// least two words making up at least half of the longer one.
function nameEvidence(a, b) {
  const ka = textKey(a);
  const kb = textKey(b);
  if (!ka || !kb) return 'unknown';
  const A = tokens(a);
  const B = tokens(b);
  const DA = distinctive(a);
  const DB = distinctive(b);
  let sharesDistinct = false;
  for (const w of DA) {
    if (DB.has(w) || [...DB].some((v) => fuzzyEq(w, v))) { sharesDistinct = true; break; }
  }
  let overlap = ka === kb || charSimilarity(a, b) >= 0.8;
  if (!overlap && A.size && B.size) {
    let inter = 0;
    for (const w of A) if (B.has(w)) inter++;
    const [small, large] = A.size <= B.size ? [A, B] : [B, A];
    overlap = inter / (A.size + B.size - inter) >= 0.5
      || (small.size >= 2 && inter === small.size && small.size / large.size >= 0.5);
  }
  if (!overlap) return 'disagree';
  if (sharesDistinct) return 'agree';
  if (!DA.size && !DB.size && (ka === kb || charSimilarity(a, b) >= 0.9)) return 'weak';
  return 'disagree';
}

function namesAgree(a, b) {
  return nameEvidence(a, b) === 'agree';
}

const DIRECTIONS = new Set(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']);
const SUFFIXES = new Set(['st', 'ave', 'dr', 'rd', 'blvd', 'ln', 'ct', 'cir', 'pkwy', 'pl', 'ter', 'hwy', 'trl', 'sq', 'way',
  'loop', 'run', 'pt', 'xing', 'row', 'walk', 'pass', 'path', 'aly', 'plz', 'cv', 'bnd', 'blf', 'ste', 'apt']);

// STRICT street agreement, for deciding whether a number may have been reused.
// A house number, a direction (N/S) or a street type (Dr/Ct) that differs is a
// DIFFERENT street — never forgiven as a typo. Only a long ordinary word may
// carry a typo ("Saddlebrok" / "Saddlebrook"), and a street type may be missing
// on one side only. true / false, or null when either side has no street.
function streetsMatchStrict(a, b) {
  const ka = streetKey(a);
  const kb = streetKey(b);
  if (!ka || !kb) return null;
  if (ka === kb) return true;
  let A = ka.split(' ');
  let B = kb.split(' ');
  if (Math.abs(A.length - B.length) === 1) {
    const [L, S] = A.length > B.length ? [A, B] : [B, A];
    if (SUFFIXES.has(L[L.length - 1]) && !SUFFIXES.has(S[S.length - 1])) A = L.slice(0, -1);
    else if (/^\d+$/.test(L[0]) && DIRECTIONS.has(L[1]) && !DIRECTIONS.has(S[1])) A = [L[0]].concat(L.slice(2));
    else return false;
    B = S;
  }
  if (A.length !== B.length) return false;
  for (let i = 0; i < A.length; i++) {
    const x = A[i];
    const y = B[i];
    if (x === y) continue;
    if (/\d/.test(x) || /\d/.test(y)) return false;
    if (DIRECTIONS.has(x) || DIRECTIONS.has(y) || SUFFIXES.has(x) || SUFFIXES.has(y)) return false;
    if (x.length < 5 || !fuzzyEq(x, y)) return false;
  }
  return true;
}

// Does the PLACE on both sides bear on identity?
//   'agree'    — strictly the same street, and nothing in zip/city/state contradicts it
//   'disagree' — a different street, or the same street line in another zip / city / state
//   'unknown'  — no street on one side and nothing contradicts
// The zip decides when both sides have one; otherwise the city (typo-tolerant);
// a two-letter state that differs always contradicts.
function placeEvidence(x, y) {
  const st = streetsMatchStrict(x.street, y.street);
  let contra = false;
  const zx = zipKey(x.zip);
  const zy = zipKey(y.zip);
  if (zx && zy) contra = zx !== zy;
  else {
    const cx = cityKey(x.city);
    const cy = cityKey(y.city);
    if (cx && cy && !fuzzyEq(cx, cy)) contra = true;
  }
  const sx = stateKey(x.state);
  const sy = stateKey(y.state);
  if (/^[A-Z]{2}$/.test(sx) && /^[A-Z]{2}$/.test(sy) && sx !== sy) contra = true;
  if (st === false) return 'disagree';
  if (st === true) return contra ? 'disagree' : 'agree';
  return contra ? 'disagree' : 'unknown';
}

function placeText(x) {
  return [x.street, x.city, x.state, x.zip].map((v) => str(v).trim()).filter(Boolean).join(', ') || 'no address';
}

// Loose (typo-tolerant) street agreement — used ONLY to find near duplicates and
// to word a typo flag, never to confirm a match.
// true / false, or null when either side has no street to compare.
function streetsAgree(a, b) {
  const ka = streetKey(a);
  const kb = streetKey(b);
  if (!ka || !kb) return null;
  if (ka === kb) return true;
  const na = ka.split(' ')[0];
  const nb = kb.split(' ')[0];
  if (/^\d+$/.test(na) && na !== nb) return false;
  return fuzzyEq(ka, kb);
}

// Same place: same street (typo-tolerant) and the zip or the city (typo-tolerant) agrees.
function samePlace(x, y, fuzzy) {
  const s = fuzzy ? streetsAgree(x.street, y.street) === true : (streetKey(x.street) !== '' && streetKey(x.street) === streetKey(y.street));
  if (!s) return false;
  const zx = zipKey(x.zip);
  if (zx && zx === zipKey(y.zip)) return true;
  const cx = cityKey(x.city);
  const cy = cityKey(y.city);
  if (!cx || !cy) return false;
  return fuzzy ? fuzzyEq(cx, cy) : cx === cy;
}

// ── money ────────────────────────────────────────────────────────────────
// { kind: 'blank' | 'value' | 'range' | 'unparsed', value, low, high }
// 0 is blank (Buildertrend shows $0 on 42 of 44 lead revenues). A non-empty
// string that is not money is UNPARSED — never blank, never a value.
//
// EVERY figure is rounded to CENTS, because that is what a dollar amount is.
// { round: false } skips ONLY that rounding and changes nothing else: not the
// grammar, not the one-sign rule, not the range arm, not blank-is-zero, not
// the {value, scale} envelope. It exists because this grammar is ALSO the only
// reader for two figures that are not money — a Buildertrend QUANTITY and a
// PERCENT (services/clickr/estimate-match.js numExact). 1.3333 squares is a
// figure Buildertrend holds and a P86 line can hold, so rounding it to 1.33
// writes a quantity neither side ever had. A second, hand-rolled parser over
// there is the thing this parameter exists to prevent: Number('1,333.3333')
// and Number({ value: 1.3333 }) are both NaN, so anything simpler than this
// grammar refuses input that imports correctly today. The DEFAULT is
// unchanged, so every existing caller reads money exactly as it always did.
function parseMoneyText(s, opts) {
  const cents = (n) => ((opts && opts.round === false) ? n : Math.round(n * 100) / 100);
  let t = s.trim();
  if (isBtBlank(t)) return { kind: 'blank' };
  const range = t.split(/\s+(?:-|–|—|to)\s+/i);
  if (range.length > 1) {
    // A range is two readable figures. "$5 - $0", "0 - $12,000" or "$5 - abc"
    // is not one figure and not a range: unparsed, shown held back.
    if (range.length !== 2) return { kind: 'unparsed' };
    const lo = parseMoneyText(range[0], opts);
    const hi = parseMoneyText(range[1], opts);
    if (lo.kind === 'value' && hi.kind === 'value') return { kind: 'range', low: lo.value, high: hi.value };
    return { kind: 'unparsed' };
  }
  // ONE sign at most: "($5.00)", "-5", "-$5" or "$-5". "--5", "(-5)", "-$-5" are unparsed.
  let neg = false;
  if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1).trim(); }
  const sign = t.match(/^(-?)\s*(\$?)\s*(-?)\s*/);
  const minus = (sign[1] ? 1 : 0) + (sign[3] ? 1 : 0);
  if (minus > 1 || (minus && neg)) return { kind: 'unparsed' };
  if (minus) neg = true;
  t = t.slice(sign[0].length);
  const m = t.match(/^(\d{1,3}(?:,\d{3})+|\d+)?(\.\d+)?\s*([kKmM])?$/);
  if (!m || (!m[1] && !m[2])) return { kind: 'unparsed' };
  let n = parseFloat((m[1] || '0').replace(/,/g, '') + (m[2] || ''));
  if (m[3]) n *= /k/i.test(m[3]) ? 1e3 : 1e6;
  if (!Number.isFinite(n)) return { kind: 'unparsed' };
  n = cents(neg ? -n : n);
  return n === 0 ? { kind: 'blank', zero: true } : { kind: 'value', value: n };
}

function parseMoney(v, opts) {
  if (v == null) return { kind: 'blank' };
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return { kind: 'unparsed' };
    if (v === 0) return { kind: 'blank', zero: true };
    return { kind: 'value', value: (opts && opts.round === false) ? v : Math.round(v * 100) / 100 };
  }
  if (typeof v === 'string') return parseMoneyText(v, opts);
  if (typeof v === 'object' && !Array.isArray(v) && Object.prototype.hasOwnProperty.call(v, 'value')) {
    // Buildertrend's {value, scale}. `value` is already in dollars (the full
    // pull's contract sum is 6,772,135.49 read this way); `scale` is its
    // display precision, not a divisor.
    if (v.value == null) return { kind: 'blank' };
    return parseMoney(v.value, opts);
  }
  return { kind: 'unparsed' };
}

function p86Number(v) {
  if (v == null || String(v).trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function fmtMoney(n) {
  if (n == null) return '';
  const neg = n < 0;
  const s = Math.abs(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-$' : '$') + s;
}

function moneyText(m) {
  if (m.kind === 'value') return fmtMoney(m.value);
  if (m.kind === 'range') return fmtMoney(m.low) + ' – ' + fmtMoney(m.high);
  return '';
}

// The one place a Buildertrend money value meets a P86 one. Never a correction.
function compareMoney(acc, spec) {
  const { field, label, bt, p86, p86Note } = spec;
  const m = parseMoney(bt);
  const p = p86Number(p86);
  if (spec.p86Unavailable) {
    if (m.kind === 'value' || m.kind === 'range' || m.kind === 'unparsed') {
      acc.heldBack.push({ field, label, reason: 'money', bt: m.kind === 'unparsed' ? 'unparsed' : moneyText(m), p86: '',
        note: spec.p86Unavailable });
    }
    return;
  }
  if (m.kind === 'blank') {
    if (p != null && p !== 0) acc.btBlank.push({ field, label, p86: fmtMoney(p), zero: !!m.zero, money: true });
    return;
  }
  if (m.kind === 'unparsed') {
    acc.heldBack.push({ field, label, reason: 'unparsed', bt: typeof bt === 'string' ? bt.slice(0, 60) : '(not a money value)',
      p86: p == null ? '' : fmtMoney(p),
      note: 'Buildertrend sent a value that is not readable money, so it was not compared. Money is never auto-corrected.' });
    return;
  }
  if (m.kind === 'range') {
    acc.heldBack.push({ field, label, reason: 'money', bt: moneyText(m), p86: p == null ? '' : fmtMoney(p),
      note: 'Buildertrend sent a range where one figure was expected. Money is never auto-corrected.' });
    return;
  }
  if (p != null && Math.abs(p - m.value) < 0.005) return;
  if (spec.correction) {
    // The owner's call for this figure: Buildertrend is the source of truth, so
    // it is a correction like any other — shown checked on the row, applied
    // only by a person pressing Apply, never by "safe updates".
    acc.corrections.push({ field, label, kind: (p == null || p === 0) ? 'fill' : 'value', money: true,
      from: p == null ? '' : fmtMoney(p), to: fmtMoney(m.value), value: m.value, p86Value: p == null ? null : p,
      note: spec.correctionNote || '' });
    return;
  }
  acc.heldBack.push({ field, label, reason: 'money', bt: fmtMoney(m.value), p86: p == null ? '' : fmtMoney(p),
    value: m.value, p86Value: p == null ? null : p, applicable: !!spec.applicable,
    note: (spec.applicable ? 'Never applied automatically — tick it to apply it on purpose.' : 'Money is never auto-corrected from this data.')
      + (p86Note ? ' ' + p86Note : '') });
}

// ── non-money fields ─────────────────────────────────────────────────────
//   BT blank, P86 has a value  -> btBlank (P86 keeps it)
//   BT value, P86 blank        -> correction kind 'fill'
//   same after normalising, written the same      -> nothing
//   same after normalising, written differently   -> correction kind 'format'
//   different                  -> correction kind 'value'
function compareField(acc, spec) {
  const { field, label, bt, p86 } = spec;
  if (isBtBlank(bt)) {
    if (!isP86Blank(p86)) acc.btBlank.push({ field, label, p86: str(p86) });
    return;
  }
  const c = { field, label, from: isP86Blank(p86) ? '' : str(p86), to: str(bt).trim() };
  if (spec.toP86 !== undefined) c.toP86 = spec.toP86;
  if (spec.note) c.note = spec.note;
  if (isP86Blank(p86)) {
    c.kind = 'fill';
    acc.corrections.push(c);
    return;
  }
  if (spec.same(bt, p86)) {
    const literal = spec.literal || ((a, b) => str(a).trim().replace(/\s+/g, ' ') === str(b).trim().replace(/\s+/g, ' '));
    if (literal(bt, p86)) return;
    c.kind = 'format';
    acc.corrections.push(c);
    return;
  }
  c.kind = 'value';
  if (spec.typo) {
    const t = spec.typo(bt, p86);
    if (t) c.typo = t;
  }
  acc.corrections.push(c);
}

function newAcc() {
  return { corrections: [], btBlank: [], heldBack: [], flags: [] };
}

const typoSentence = (bt, p86) => 'Buildertrend has "' + str(bt).trim() + '", a small typo away from P86\'s "' + str(p86).trim()
  + '". P86 would still receive Buildertrend\'s value — fix it in Buildertrend, or the next sync overwrites a P86 edit.';

function addressFields(acc, bt, p) {
  compareField(acc, { field: 'street', label: 'Street', bt: bt.street, p86: p.street,
    same: (a, b) => streetKey(a) === streetKey(b),
    typo: (a, b) => (streetsAgree(a, b) ? typoSentence(a, b) : null) });
  compareField(acc, { field: 'city', label: 'City', bt: bt.city, p86: p.city,
    same: (a, b) => cityKey(a) === cityKey(b),
    typo: (a, b) => (fuzzyEq(cityKey(a), cityKey(b)) ? typoSentence(a, b) : null) });
  compareField(acc, { field: 'state', label: 'State', bt: bt.state, p86: p.state,
    same: (a, b) => stateKey(a) === stateKey(b),
    typo: (a) => (/^[A-Za-z]{2}$/.test(str(a).trim()) ? null
      : 'Buildertrend\'s state "' + str(a).trim() + '" is not a two-letter state code. P86 would still receive it — fix it in Buildertrend.') });
  compareField(acc, { field: 'zip', label: 'Zip', bt: bt.zip, p86: p.zip,
    same: (a, b) => zipKey(a) !== '' && zipKey(a) === zipKey(b) });
}

// ── jobs ─────────────────────────────────────────────────────────────────

const NUM_TOKEN = /^[A-Za-z]{0,3}\d+$/;
const MULTI_TOKEN = /^[A-Za-z]{0,3}\d+(?:\/[A-Za-z]{0,3}\d+)+$/;
// ONLY a parenthesised "(CO<digits>)". "CO 80202" (a Colorado zip), "CO2
// Monitor" and "- CO-2" are not change-order markers.
const CO_MARK = /\(\s*CO(\d+)\s*\)/i;

// "S1234 Foo" -> number S1234, title Foo. "RV2012/RV2013 Foo" -> numbers both.
// "(CO1)" anywhere -> change order. No zero-stripping: WO0012 stays WO0012.
function parseJobName(raw) {
  const s = str(raw).trim();
  const out = { raw: s, number: null, numbers: [], title: s, isChangeOrder: false, coLabel: null };
  if (!s) return out;
  const first = s.split(/\s+/)[0];
  const tok = first.replace(/[-:,|]+$/, '');
  let rest = s.slice(first.length);
  if (MULTI_TOKEN.test(tok)) {
    out.numbers = tok.toUpperCase().split('/');
  } else if (NUM_TOKEN.test(tok)) {
    out.number = tok.toUpperCase();
    out.numbers = [out.number];
  } else {
    rest = s;
  }
  const cm = rest.match(CO_MARK);
  if (cm) {
    out.isChangeOrder = true;
    out.coLabel = 'CO' + cm[1];
    rest = rest.slice(0, cm.index) + ' ' + rest.slice(cm.index + cm[0].length);
  }
  out.title = rest.replace(/\s+/g, ' ').replace(/^[\s\-–—:|]+/, '').trim();
  return out;
}

function exactNumberKey(v) {
  return str(v).trim().toUpperCase();
}

// Loose form, used ONLY to find numbers written differently (WO0012 vs WO12,
// "WO-12"). A loose-only hit is never a match.
function looseNumberKey(v) {
  const t = str(v).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const m = t.match(/^([A-Z]{0,3})(\d+)$/);
  return m ? m[1] + String(Number(m[2])) : '';
}

// P86 job status vocabulary (js/jobs.js edit card: New, Backlog, In Progress,
// On Hold, Warranty, Completed, Archived). Anything else is UNKNOWN — and a
// status outside this vocabulary stops ALL status comparison for that job
// (jobProposals below), so a status P86 really has must be IN here or its
// jobs go quiet.
//
// Warranty is its OWN state, deliberately not folded into P86_ACTIVE: the
// two questions "has Buildertrend reopened this warranty job" and "has
// Buildertrend closed it" both need to tell warranty apart from in-progress.
const P86_ACTIVE = new Set(['new', 'backlog', 'in progress', 'on hold']);
function p86JobState(v) {
  const t = str(v).trim().toLowerCase().replace(/\s+/g, ' ');
  if (!t) return null;
  if (t === 'warranty') return 'warranty';
  if (P86_ACTIVE.has(t)) return 'active';
  if (t === 'completed') return 'completed';
  if (t === 'archived') return 'archived';
  return null;
}
function btJobState(v) {
  const t = str(v).trim().toLowerCase();
  if (t === 'open') return 'open';
  if (t === 'closed') return 'closed';
  if (t === 'warranty') return 'warranty';
  return null;
}
function btScope(v) {
  const s = btJobState(v);
  if (s === 'open' || s === 'warranty') return 'open';
  if (s === 'closed') return 'closed';
  return 'unknown';
}

function coreTitle(title, numbers) {
  const s = str(title).trim();
  const first = s.split(/\s+/)[0] || '';
  const tok = first.replace(/[-:,|]+$/, '').toUpperCase();
  if (tok && numbers.some((n) => n && exactNumberKey(n) === tok)) {
    return s.slice(first.length).replace(/^[\s\-–—:|]+/, '').trim();
  }
  return s;
}

// BUILDERTREND'S OWN WORD against the word P86 stored for it (data.btStatus,
// written only by sync-apply.js). A row whose two sides already AGREE carries
// no correction at all — so without this signal a confident, already-linked
// row would offer nothing to press and P86 would keep the word it was linked
// with for ever. (Warranty jobs and Pending change orders used to be the
// standing example, because P86 had neither status; it now has both, and they
// are ordinary agreeing rows.) Blank-aware on the Buildertrend
// side, exactly as sync-apply.js writes it, so a blank sentinel does not leave
// the safe press permanently due.
function btStatusDue(btWord, stored) {
  const now = isBtBlank(btWord) ? '' : str(btWord).trim().replace(/\s+/g, ' ');
  return now !== str(stored).trim().replace(/\s+/g, ' ');
}

function p86JobView(row) {
  const d = row.data || {};
  return {
    id: row.id,
    jobNumber: str(d.jobNumber).trim(),
    title: str(d.title || d.name).trim(),
    status: str(d.status),
    street: str(d.street_address),
    city: str(d.city),
    state: str(d.state),
    zip: str(d.zip),
    startDate: str(d.startDate),
    contractAmount: d.contractAmount == null ? '' : str(d.contractAmount),
    state86: p86JobState(d.status),
    // What Buildertrend last called it, as sync-apply.js recorded it (J2).
    btStatus: str(d.btStatus).trim(),
    // jobs.bt_job_id — set only by sync-apply.js when an admin applies a match.
    btId: row.bt_job_id == null ? '' : str(row.bt_job_id).trim(),
  };
}

function jobCand(p, rungs) {
  return { id: p.id, jobNumber: p.jobNumber, title: p.title, status: p.status,
    street: p.street, city: p.city, state: p.state, zip: p.zip, rungs: [...rungs] };
}

function jobProposals(bt, p, ctx) {
  const acc = newAcc();
  const notes = [];
  // TITLE: compared without a leading job number on either side.
  const pCore = coreTitle(p.title, [p.jobNumber, bt.number]);
  const pCarriesNumber = pCore !== p.title;
  compareField(acc, { field: 'title', label: 'Job title',
    bt: pCarriesNumber && bt.title ? p.title.slice(0, p.title.length - pCore.length) + bt.title : bt.title,
    p86: p.title,
    same: (a) => textKey(coreTitle(a, [p.jobNumber, bt.number])) === textKey(pCore),
    literal: (a) => coreTitle(a, [p.jobNumber, bt.number]).replace(/\s+/g, ' ') === pCore.replace(/\s+/g, ' ') });
  addressFields(acc, bt, p);

  // STATUS.
  const bs = btJobState(bt.status);
  if (isBtBlank(bt.status)) {
    if (!isP86Blank(p.status)) acc.btBlank.push({ field: 'status', label: 'Status', p86: p.status });
  } else if (!bs) {
    notes.push('Buildertrend status "' + str(bt.status).trim() + '" is not Open, Closed or Warranty, so it was not compared.');
  } else if (!p.state86) {
    notes.push('P86 status "' + str(p.status) + '" is outside P86\'s job status vocabulary, so status was not compared.');
  } else if (bs === 'warranty' && (p.state86 === 'active' || p.state86 === 'completed')) {
    // P86 has a Warranty status of its own now, so this is an ordinary
    // forward correction rather than a flag that could never be acted on.
    // ENUMERATED, not negated: a job goes into warranty from active work or
    // from completion. An ARCHIVED P86 job is deliberately left alone — what a
    // Buildertrend status should do to one is not decided, and the note below
    // ("the job stays active") would be untrue of a job coming out of the
    // archive. Warranty on both sides falls through with nothing, as it should.
    acc.corrections.push({ field: 'status', label: 'Status', kind: 'value', from: p.status, to: 'Warranty', toP86: 'Warranty',
      note: 'Warranty is a P86 job status: the job stays active — its WIP, backlog, revenue earned and margin are unchanged, and it can still raise POs, COs and RFIs.' });
  } else if (bs === 'open' && p.state86 !== 'active') {
    acc.corrections.push({ field: 'status', label: 'Status', kind: 'value', from: p.status, to: 'Open', toP86: 'In Progress',
      note: 'Buildertrend Open is an active P86 status; "In Progress" is shown. Confirm which active status a sync should set.' });
  } else if (bs === 'closed' && (p.state86 === 'active' || p.state86 === 'warranty')) {
    // 'warranty' belongs here or a job that is Warranty on BOTH sides goes
    // permanently quiet the day Buildertrend closes it: no correction, no
    // note, a clean-looking matched row. Found months later, if ever.
    acc.corrections.push({ field: 'status', label: 'Status', kind: 'value', from: p.status, to: 'Closed', toP86: 'Completed' });
  }

  // PROJECTED START -> data.startDate, as a calendar day, FILL ONLY. The owner's
  // call: Buildertrend's projected start is a planning date, so it fills a P86
  // job that has none and never replaces a start date someone set in P86 (that
  // is usually the actual start).
  if (!isBtBlank(bt.projectedStart) && !dateKey(bt.projectedStart)) {
    notes.push('Buildertrend projected start "' + str(bt.projectedStart).slice(0, 40) + '" is not a readable date, so it was not compared.');
  } else if (!isP86Blank(p.startDate)) {
    // P86 already has a start date: it stands. Nothing proposed, nothing noted.
  } else {
    const btDay = dateKey(bt.projectedStart);
    compareField(acc, { field: 'startDate', label: 'Start date', bt: btDay || bt.projectedStart, p86: p.startDate,
      same: (a, b) => dateKey(b) !== '' && dateKey(a) === dateKey(b),
      literal: () => true });
  }

  // CONTRACT PRICE — Buildertrend is the source of truth (owner's decision,
  // 2026-09-13), so a difference is a correction on data.contractAmount. A
  // Buildertrend $0 or blank is still blank: it never erases a P86 contract.
  compareMoney(acc, { field: 'contractPrice', label: 'Contract price', bt: bt.contractPrice, p86: p.contractAmount,
    correction: true,
    correctionNote: 'Buildertrend\'s contract price is the source of truth. This sets the job\'s contract amount: income, backlog, profit and margin move with it; the scope allocation is not re-spread.' });
  // APPROVED CHANGE ORDERS — P86 computes this from its change orders, so there
  // is no single number to set. Shown, never applicable.
  const co = ctx.coTotals ? ctx.coTotals.get(p.id) : null;
  compareMoney(acc, { field: 'approvedCOPrice', label: 'Approved change orders', bt: bt.approvedCOPrice,
    p86: co && co.computable ? co.total : null,
    p86Unavailable: co && !co.computable ? co.why : (ctx.coTotals ? null : 'P86\'s change orders were not read.'),
    p86Note: (co ? 'P86 figure: ' + co.source + '. ' : '') + 'It is the sum of P86\'s change orders, so it cannot be set here — change the change orders.' });

  // JOB NUMBER — identity. Never applied automatically; a person may tick it.
  if (bt.number && exactNumberKey(bt.number) !== exactNumberKey(p.jobNumber)) {
    // A number MORE THAN ONE Buildertrend job carries is not offered at all:
    // P86 numbers exactly one job with it, so ticking it could only take it off
    // whichever job held it first.
    const sharedBy = bt.numberSharedBy || 0;
    acc.heldBack.push({ field: 'jobNumber', label: 'Job number', reason: 'identity', bt: bt.number, p86: p.jobNumber,
      value: bt.number, applicable: !sharedBy,
      note: sharedBy
        ? sharedBy + ' Buildertrend jobs carry the number ' + bt.number + ', so it is not offered here — P86 numbers one job with it. Give each its own number in Buildertrend first.'
        : 'The job number is P86\'s identity and the QuickBooks cost-import key. Never applied automatically — tick it to renumber this job on purpose.' });
  }
  return { acc, notes };
}

function clearProposals(r) {
  r.corrections = [];
  r.btBlank = [];
  r.heldBack = [];
  r.flags = [];
}

function unpairedRow(bt, cls, candidates, notes) {
  return { bt, class: cls, rung: null, p86: null, corrections: [], btBlank: [], heldBack: [], flags: [], candidates: candidates || [], notes: notes || [] };
}

function indexBy(list, keyFn) {
  const m = new Map();
  for (const x of list) {
    const k = keyFn(x);
    if (!k) continue;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}

// ── the NEAR TITLE: "the same work, worded differently" ─────────────────────
// A near rung asks whether two names are one piece of work written twice, and
// WORD ORDER, an ABBREVIATION and a PLURAL do not bear on that question. Both of
// these pairs are one lead, and both were 0.77 apart as written — under every
// threshold here, so neither was reached at all:
//   "Edgewater Roof Leak 255/205" / "Roof leak at Edgewater 255 and 205"
//   "Bldg 9 Balcony Repairs"      / "Building 9 Balcony Repair"
// So the near key sorts the words, expands the abbreviations this trade writes
// and folds the plurals before anything is compared. textKey() is NOT touched:
// the exact rungs still match a name exactly as written. This key is read only
// by the near rungs, where a false hit costs a REVIEW and never a match.
const NEAR_ABBREV = {
  bldg: 'building', blg: 'building', bldng: 'building', apt: 'apartment',
  ste: 'suite', rm: 'room', ctr: 'center', mgmt: 'management', maint: 'maintenance',
};

function nearWord(w) {
  let x = NEAR_ABBREV[w] || w;
  // A plural is the same word — "Repairs" is "Repair" — but "Glass" is not "Glas".
  if (x.length > 3 && x.endsWith('s') && !x.endsWith('ss')) x = x.slice(0, -1);
  return NEAR_ABBREV[x] || x;
}

// Every word that says WHICH work this is, in one order. The stop words go,
// because they are what a rewording adds ("Roof leak AT Edgewater"); the
// numbers stay, because "Bldg 9" and "Bldg 12" are different buildings.
function nearKey(s) {
  const out = [];
  for (const w of textKey(s).split(' ')) {
    if (!w || STOP.has(w)) continue;
    out.push(nearWord(w));
  }
  return out.sort().join(' ');
}

// ── the NEAR rungs, indexed ─────────────────────────────────────────────────
// A similar name (nearNames below, over the near key) or the same place written
// with a typo. Comparing every Buildertrend row with every P86 record ran in the
// request and blocked the live server for seconds (692 x 900 = 4 s). The same
// test is now answered from two indexes: a bigram posting list (the Dice
// intersection is summed only over records that share a bigram) and the
// street's house number (a typo-tolerant street agrees only on the SAME house
// number). The answer is identical to the brute-force loop over nearTitles(),
// in the same record order — executed against it in
// test/clickr-sync-preview.test.js ("the index and the one-pair test").
const NEAR_NAME = 0.85;
// Below that threshold, the same BOUNDED word test the exact rungs use, on the
// near key: a rewording that adds or drops a word ("Roof Leak - Edgewater Bldgs
// 255 & 205" for "Edgewater Roof Leak 255/205") still has to share a
// DISTINCTIVE word, or be the same generic name twice. The Dice floor is what
// keeps it affordable — it is read off the posting list that is already summed,
// and a name below it cannot carry half of the other's words anyway. Measured
// on the real shape (692 Buildertrend jobs x 900 P86 jobs, repeated trade
// vocabulary): 239 ms against 58 ms without the arm, where the brute-force loop
// this index replaced cost 4 s.
const NEAR_WORDS = 0.5;

function nearNames(dice, ka, kb) {
  if (dice >= NEAR_NAME) return true;
  if (dice < NEAR_WORDS) return false;
  const e = nameEvidence(ka, kb);
  return e === 'agree' || e === 'weak';
}

// Two titles, compared the way the near rungs compare them. The index below
// answers the same question from a posting list; this answers it for ONE pair,
// and both go through nearNames so the two can never drift apart.
function nearTitles(a, b) {
  const ka = nearKey(a);
  const kb = nearKey(b);
  if (!ka || !kb) return false;
  return nearNames(charSimilarity(ka, kb), ka, kb);
}

function nearIndex(items, titleOf) {
  const postings = new Map();   // bigram -> { idx: [item index], cnt: [count] }
  const sizes = new Int32Array(items.length);
  const inter = new Int32Array(items.length);
  const order = new Map();
  const byFirst = new Map();
  const unnumbered = [];
  const keys = [];
  items.forEach((it, i) => {
    order.set(it.id, i);
    keys[i] = nearKey(titleOf(it));
    const g = bigrams(keys[i]);
    let n = 0;
    for (const [k, c] of g) {
      n += c;
      if (!postings.has(k)) postings.set(k, { idx: [], cnt: [] });
      const p = postings.get(k);
      p.idx.push(i);
      p.cnt.push(c);
    }
    sizes[i] = n;
    const sk = streetKey(it.street);
    if (!sk) return;
    const f = sk.split(' ')[0];
    if (!byFirst.has(f)) byFirst.set(f, []);
    byFirst.get(f).push(it);
    unnumbered.push([it, sk.length]);
  });
  // near(title, place, skip) -> [{ it, why: [...] }] in `items` order.
  return function near(title, place, skip, labels) {
    const hits = new Map();
    const hit = (it, why) => {
      if (!hits.has(it.id)) hits.set(it.id, { it, why: [] });
      hits.get(it.id).why.push(why);
    };
    const qk = nearKey(title);
    if (qk) {
      const A = bigrams(qk);
      let na = 0;
      for (const c of A.values()) na += c;
      if (na) {
        const touched = [];
        for (const [k, c] of A) {
          const p = postings.get(k);
          if (!p) continue;
          for (let j = 0; j < p.idx.length; j++) {
            const ix = p.idx[j];
            if (inter[ix] === 0) touched.push(ix);
            inter[ix] += c < p.cnt[j] ? c : p.cnt[j];
          }
        }
        for (const ix of touched) {
          const x = inter[ix];
          inter[ix] = 0;
          if (!skip(items[ix]) && nearNames((2 * x) / (na + sizes[ix]), qk, keys[ix])) hit(items[ix], labels.name);
        }
      }
    }
    const sk = streetKey(place.street);
    if (sk) {
      const f = sk.split(' ')[0];
      // streetsAgree: a numbered street agrees only with the same house number;
      // an unnumbered one is a whole-string typo match, never more than 2 edits.
      const pool = /^\d+$/.test(f) ? (byFirst.get(f) || [])
        : unnumbered.filter(([, len]) => Math.abs(len - sk.length) <= 2).map(([it]) => it);
      for (const it of pool) {
        if (!skip(it) && samePlace(place, it, true)) hit(it, labels.place);
      }
    }
    return [...hits.values()].sort((a, b) => order.get(a.it.id) - order.get(b.it.id))
      .map((h) => ({ it: h.it, why: h.why.sort((a, b) => (a === labels.name ? -1 : b === labels.name ? 1 : 0)) }));
  };
}

// The rung a number MORE THAN ONE Buildertrend job carries is listed under. It
// reaches the P86 job that holds the number — so the job is shown, is kept out
// of "in P86, not in Buildertrend", and can be linked by hand — and it never
// decides a row.
const SHARED_NUMBER_RUNG = 'number (shared in Buildertrend)';

// btValues: field-map readJob() values. p86Rows: { id, data }. ctx.coTotals:
// Map(jobId -> { computable, total, source, why }).
function matchJobs(btValues, p86Rows, ctx) {
  const c = ctx || {};
  const p86 = p86Rows.map(p86JobView);
  const byExact = indexBy(p86, (p) => exactNumberKey(p.jobNumber));
  const byLoose = indexBy(p86, (p) => looseNumberKey(p.jobNumber));
  const byName = indexBy(p86, (p) => textKey(coreTitle(p.title, [p.jobNumber])));
  const byStreet = indexBy(p86, (p) => streetKey(p.street));
  const near = nearIndex(p86, (p) => coreTitle(p.title, [p.jobNumber]));
  const NEAR_LABELS = { name: 'similar name', place: 'same address, typo-tolerant' };
  const byBtId = indexBy(p86, (p) => p.btId);

  const parsed = btValues.map((v) => parseJobName(v.jobName));
  // A number is SHARED when more than one non-change-order row carries it. A
  // "(CO1)" row repeats its parent's number by design and does not count, and
  // neither does a row Buildertrend marks deleted.
  const shared = new Map();
  parsed.forEach((pj, i) => {
    if (pj.isChangeOrder || btValues[i].isDeleted) return;
    for (const n of pj.numbers) shared.set(n, (shared.get(n) || 0) + 1);
  });

  const rows = btValues.map((v, i) => {
    const pj = parsed[i];
    const bt = {
      index: i, btId: v.btId, raw: pj.raw, number: pj.number, numbers: pj.numbers, title: pj.title,
      status: str(v.jobStatus), scope: btScope(v.jobStatus),
      street: str(v.street), city: str(v.city), state: str(v.state), zip: str(v.zip),
      projectedStart: str(v.projectedStart), contractPrice: v.contractPrice, approvedCOPrice: v.approvedCOPrice,
      coLabel: pj.coLabel,
      contactIds: Array.isArray(v.contactIds) ? v.contactIds.map(str) : [],
    };
    const contractView = parseMoney(v.contractPrice);
    bt.contractText = contractView.kind === 'unparsed' ? 'unparsed' : moneyText(contractView);
    bt.contractValue = contractView.kind === 'value' ? contractView.value : null;
    delete bt.contractPrice;
    delete bt.approvedCOPrice;
    const moneyIn = { contractPrice: v.contractPrice, approvedCOPrice: v.approvedCOPrice };

    if (v.isDeleted) return unpairedRow(bt, 'refused', [], ['Buildertrend marks this job deleted, so it is not matched and never created.']);
    if (isBtBlank(pj.raw)) return unpairedRow(bt, 'refused', [], ['This Buildertrend job has no name, so it cannot be matched and will never be created.']);
    if (pj.isChangeOrder) return Object.assign(unpairedRow(bt, 'change_order', [], []), { parentNumber: pj.number });
    if (!pj.numbers.length) {
      return unpairedRow(bt, 'not_a_job', [], ['No job number at the front of the name — a Buildertrend bucket such as "General" or "Pre-sale", not a job. Excluded from the match rate.']);
    }
    // "S7001", "S7002 TBD", "S7003 --": a number with no name after it. The
    // title is Buildertrend-blank: it is never compared, never proposed, and the
    // row is never created.
    const titleBlank = isBtBlank(pj.title);
    const title = titleBlank ? '' : pj.title;

    // RUNG 0 — THE BUILDERTREND ID. A P86 job already linked to this Buildertrend
    // job (sync-apply.js stamps jobs.bt_job_id when an admin applies a match) IS
    // its counterpart, whatever the number, name or address say now. A P86 job
    // linked to a DIFFERENT Buildertrend job is never a candidate for this row.
    const btKey = v.btId == null ? '' : String(v.btId).trim();
    const linked = btKey ? (byBtId.get(btKey) || []) : [];
    const free = (p) => !p.btId || p.btId === btKey;

    const cands = new Map();
    const add = (list, rung) => {
      for (const p of list || []) {
        if (!cands.has(p.id)) cands.set(p.id, { p, rungs: new Set() });
        cands.get(p.id).rungs.add(rung);
      }
    };
    const exact = [];
    const loose = [];
    for (const n of pj.numbers) {
      for (const p of byExact.get(exactNumberKey(n)) || []) if (free(p)) exact.push(p);
      for (const p of byLoose.get(looseNumberKey(n)) || []) if (free(p) && exactNumberKey(p.jobNumber) !== exactNumberKey(n)) loose.push(p);
    }
    // THE NUMBER, WHEN MORE THAN ONE BUILDERTREND JOB CARRIES IT. It then tells
    // those jobs apart from nothing, so it decides none of them. P86 cannot
    // renumber Buildertrend, so refusing all of them left 35 jobs stuck for
    // good; the number is simply ignored FOR THOSE JOBS, and the rungs below
    // (name, address, name + address) are what they are matched on instead.
    // sharedBy is 0 unless MORE THAN ONE row carries it: `shared` counts every
    // row, so a number only this job uses reads 1 there and is not shared.
    const sharedBy = pj.numbers.length === 1 && (shared.get(pj.number) || 0) > 1 ? shared.get(pj.number) : 0;
    const numberShared = sharedBy > 0;
    if (!numberShared) {
      add(exact, 'number');
      add(loose, 'number written differently');
    }
    const byNumber = numberShared ? [] : exact;
    const byLooseNumber = numberShared ? [] : loose;
    const sharedNote = numberShared
      ? sharedBy + ' Buildertrend jobs carry the number ' + pj.number + ', so it identifies none of them and was not used to match this row.'
      : null;
    // A P86 job that carries the shared number is not a CANDIDATE either: as a
    // candidate it landed on all five rows at once and refused four of them for
    // "sharing a name or address" they never shared. It is SHOWN instead, under
    // "also considered" — reached, kept out of "in P86, not in Buildertrend",
    // and linkable by hand — where it decides nothing.
    const sharedSeen = [];
    if (numberShared) {
      for (const p of exact.concat(loose)) if (!sharedSeen.some((x) => x.id === p.id)) sharedSeen.push(p);
    }
    const sharedIds = new Set(sharedSeen.map((p) => p.id));
    const withShared = (row) => {
      if (!sharedSeen.length) return row;
      const already = new Set([].concat(row.p86 ? [row.p86] : [], row.candidates || [], row.p86Duplicates || []).map((x) => x.id));
      const rest = sharedSeen.filter((p) => !already.has(p.id));
      if (rest.length) row.considered = (row.considered || []).concat(rest.map((p) => jobCand(p, [SHARED_NUMBER_RUNG])));
      return row;
    };
    const nk = textKey(title);
    const nameHits = nk ? (byName.get(nk) || []).filter(free) : [];
    const sk = streetKey(v.street);
    const placeHits = sk ? (byStreet.get(sk) || []).filter((p) => free(p) && samePlace(bt, p, false)) : [];
    add(nameHits.filter((p) => placeHits.includes(p)), 'name + address');
    add(nameHits, 'name');
    add(placeHits, 'address');
    // The NEAR rungs are collected for EVERY numbered row (never first-rung-wins).
    // On an ambiguous row they are candidates; next to a confident match they are
    // shown as possible P86 duplicates; alone they make a possible duplicate.
    const linkedIds = new Set(linked.map((p) => p.id));
    const nearList = near(title, bt, (p) => cands.has(p.id) || linkedIds.has(p.id) || sharedIds.has(p.id) || !free(p), NEAR_LABELS).map((h) => jobCand(h.it, h.why));
    const allCands = () => [...cands.values()].map((x) => jobCand(x.p, x.rungs)).concat(nearList);
    const amb = (note) => withShared(unpairedRow(bt, 'ambiguous', allCands(), sharedNote ? [note, sharedNote] : [note]));

    const confidentRow = (p, rungName, cNotes) => {
      const { acc, notes } = jobProposals(Object.assign({}, bt, { title, numberSharedBy: sharedBy }, moneyIn), p, c);
      const row = {
        bt, class: acc.corrections.length ? 'conflict' : 'matched', rung: rungName, p86: jobCand(p, [rungName]),
        btStatusDue: btStatusDue(bt.status, p.btStatus),
        corrections: acc.corrections, btBlank: acc.btBlank, heldBack: acc.heldBack, flags: acc.flags,
        candidates: [], notes: cNotes.concat(notes), p86Duplicates: [], considered: [],
      };
      if (nearList.length) {
        // The match stands, but P86 also holds jobs that look like this one. They
        // are not reached — they stay in "in P86, not in Buildertrend", linked
        // back to this row.
        row.p86Duplicates = nearList;
        row.flags.push({ field: 'duplicate', label: 'Possible P86 duplicate',
          text: 'P86 also holds ' + nearList.length + ' job' + (nearList.length === 1 ? '' : 's') + ' that look' + (nearList.length === 1 ? 's' : '')
            + ' like this one: ' + nearList.map((x) => [x.jobNumber, x.title].filter(Boolean).join(' ') || x.id).join('; ')
            + '. Nothing about ' + (nearList.length === 1 ? 'it' : 'them') + ' is proposed — review for a duplicate in P86.' });
      }
      return withShared(row);
    };

    if (linked.length > 1) {
      return unpairedRow(bt, 'ambiguous', linked.map((p) => jobCand(p, ['Buildertrend ID'])),
        [linked.length + ' P86 jobs are linked to this Buildertrend job. Nothing is proposed; unlink the extra one.']);
    }
    if (linked.length === 1) return confidentRow(linked[0], 'Buildertrend ID', []);

    if (pj.numbers.length > 1) {
      return amb('Two job numbers in one name (' + pj.numbers.join(', ') + '). Nothing is proposed; fix it in Buildertrend.');
    }
    const num = pj.number;
    let confident = null;
    let rung = null;
    const confidenceNotes = [];
    if (byNumber.length > 1) {
      return amb('P86 holds ' + byNumber.length + ' jobs numbered ' + num + '. Nothing is proposed.');
    }
    if (byNumber.length === 1) {
      const p = byNumber[0];
      const others = [...cands.values()].filter((x) => x.p.id !== p.id);
      if (others.length) {
        return amb('The number matches P86 job ' + (p.jobNumber || p.id) + ', but ' + others.length + ' other P86 job'
          + (others.length === 1 ? '' : 's') + ' share' + (others.length === 1 ? 's' : '') + ' its name, address or number written differently. Nothing is proposed.');
      }
      // THE REUSED-NUMBER GUARD. The number alone is not trusted when what
      // Buildertrend says about the job contradicts it: the name and the place
      // are each weighed, a blank is "unknown" (never "disagrees"), and the place
      // is compared strictly (Bay Dr is not Bay Ct, N Main is not S Main, and
      // the same street line in another zip is another place).
      const pCore = coreTitle(p.title, [p.jobNumber]);
      let ne = nameEvidence(title, pCore);
      if (ne === 'weak') ne = 'unknown';
      const pe = placeEvidence(bt, p);
      const btName = '"' + title + '"';
      const pName = '"' + (p.title || '') + '"';
      if (ne === 'disagree' && pe === 'disagree') {
        return amb('The number matches, but the name (' + btName + ' vs ' + pName + ') and the address (' + placeText(bt) + ' vs '
          + placeText(p) + ') both disagree, so the number may be reused. Nothing is proposed.');
      }
      if (ne === 'disagree' && pe === 'unknown') {
        return amb('The number matches, but the name disagrees (' + btName + ' vs ' + pName + ') and there is no street on both sides to confirm it, so the number may be reused. Nothing is proposed.');
      }
      if (ne === 'unknown' && pe === 'disagree') {
        return amb('The number matches, but ' + (title ? 'P86 has no name' : 'Buildertrend has no name') + ' to compare and the address disagrees ('
          + placeText(bt) + ' vs ' + placeText(p) + '), so the number may be reused. Nothing is proposed.');
      }
      if (ne === 'unknown' && pe === 'unknown') {
        confidenceNotes.push('Matched on the job number alone: neither the name nor the street can be compared (blank on one side), and nothing contradicts it.');
      }
      confident = p;
      rung = 'number';
    } else if (byLooseNumber.length) {
      return amb('No P86 job is numbered exactly ' + num + ', but ' + byLooseNumber.map((p) => p.jobNumber).join(', ')
        + ' is the same number written differently. That is not treated as a match; nothing is proposed.');
    } else if (cands.size === 1) {
      const only = [...cands.values()][0];
      // A shared Buildertrend number is no reason to refuse the name AND the
      // address: the number is the evidence that failed, not P86's own number.
      if (only.rungs.has('name + address') && (isP86Blank(only.p.jobNumber) || numberShared)) {
        confident = only.p;
        rung = 'name + address';
        if (numberShared) {
          confidenceNotes.push('Matched on the name and the address: ' + sharedNote
            + (isP86Blank(only.p.jobNumber) ? '' : ' P86 keeps its own number ' + only.p.jobNumber + '.'));
        }
      } else if (only.rungs.has('name + address')) {
        return amb('Same name and address, but P86 numbers this job ' + only.p.jobNumber + ' and Buildertrend ' + num + '. Nothing is proposed.');
      } else {
        return amb('Only a weak match (' + [...only.rungs].join(', ') + '), so it is not counted as matched and nothing is proposed.');
      }
    } else if (cands.size > 1) {
      return amb(cands.size + ' P86 jobs share this job\'s name or address. Nothing is proposed.');
    }

    if (confident) return confidentRow(confident, rung, confidenceNotes);

    // Would be new. A NEAR duplicate makes it a review item instead.
    const newNotes = [];
    if (sharedNote) {
      // TRUE of the create, and only of the create: P86 refuses a second job
      // with one number, so renumbering in Buildertrend is what unblocks the
      // rest — it is no longer what unblocks the MATCH.
      newNotes.push(sharedNote + ' P86 numbers one job with it, so only one of the ' + sharedBy
        + ' can be created — give the others their own number in Buildertrend first.');
    }
    if (nearList.length) {
      return withShared(unpairedRow(bt, 'possible_duplicate', nearList,
        ['No P86 job matches exactly, but ' + nearList.length + ' look' + (nearList.length === 1 ? 's' : '') + ' like this one. Review before anything is created.'].concat(newNotes)));
    }
    if (titleBlank) {
      return withShared(unpairedRow(bt, 'refused', [], ['This Buildertrend job has a number (' + num + ') but no name, so it cannot be confirmed against P86 and will never be created.']));
    }
    return withShared(unpairedRow(bt, 'new', [], newNotes));
  });

  demoteCollisions(rows, 'job');

  // Change orders attach to their parent AFTER collisions settle.
  const parents = indexBy(rows.filter((r) => r.class !== 'change_order' && r.class !== 'refused'), (r) => r.bt.number);
  for (const r of rows) {
    if (r.class !== 'change_order') continue;
    const ps = r.parentNumber ? (parents.get(r.parentNumber) || []) : [];
    if (!r.parentNumber) {
      r.parent = null;
      r.notes.push('A change-order row with no job number, so it has no parent to attach to.');
    } else if (!ps.length) {
      // No Buildertrend parent row was fetched. The row still NAMES a number, so
      // a P86 job carrying it is reached (it is not "absent from Buildertrend").
      const inP86 = byExact.get(exactNumberKey(r.parentNumber)) || [];
      if (inP86.length === 1) {
        const pp = jobCand(inP86[0], ['number (named by this change order)']);
        const co = c.coTotals ? c.coTotals.get(pp.id) : null;
        r.parent = { btIndex: null, btRaw: null, class: null, p86: pp, p86Only: true, p86ChangeOrders: co ? co.count : null };
        r.notes.push('No Buildertrend job numbered ' + r.parentNumber + ' was fetched. P86 job ' + (pp.jobNumber || pp.id)
          + ' carries that number, so it is not listed as absent from Buildertrend. Nothing is proposed.');
      } else {
        r.parent = null;
        r.candidates = inP86.map((p) => jobCand(p, ['number (named by this change order)']));
        r.notes.push('No Buildertrend job numbered ' + r.parentNumber + ' was fetched, so this change order has no parent'
          + (inP86.length ? '; ' + inP86.length + ' P86 jobs carry that number.' : '.'));
      }
    } else if (ps.length > 1) {
      r.parent = null;
      r.notes.push(ps.length + ' Buildertrend jobs carry ' + r.parentNumber + ', so the parent is ambiguous.');
    } else {
      const par = ps[0];
      const pp = (par.class === 'matched' || par.class === 'conflict') ? par.p86 : null;
      const co = pp && c.coTotals ? c.coTotals.get(pp.id) : null;
      r.parent = { btIndex: par.bt.index, btRaw: par.bt.raw, class: par.class, p86: pp, p86ChangeOrders: co ? co.count : null };
      r.notes.push('Maps to a change order on its parent job, never to a job of its own.');
    }
  }
  return rows;
}

// ── leads ────────────────────────────────────────────────────────────────

const LEAD_OPEN = new Set(['new', 'in_progress', 'sent']);
const LEAD_CLOSED = new Set(['sold', 'lost', 'no_opportunity']);
function p86LeadState(v) {
  const t = str(v).trim().toLowerCase();
  if (LEAD_OPEN.has(t)) return 'open';
  if (LEAD_CLOSED.has(t)) return 'closed';
  return null;
}

function personKey(v) {
  return str(v).trim().replace(/\s+/g, ' ').toLowerCase();
}

function p86LeadView(row) {
  return {
    id: row.id,
    title: str(row.title),
    status: str(row.status),
    street: str(row.street_address),
    city: str(row.city),
    state: str(row.state),
    zip: str(row.zip),
    source: str(row.source),
    confidence: row.confidence == null ? '' : str(row.confidence),
    revenueLow: row.estimated_revenue_low == null ? '' : str(row.estimated_revenue_low),
    revenueHigh: row.estimated_revenue_high == null ? '' : str(row.estimated_revenue_high),
    salesperson: str(row.salesperson_name),
    client: str(row.client_name),
    // The THIRD place a field has to be named to survive: the Buildertrend
    // record, the Buildertrend view, and the P86 view are all enumerated one
    // key at a time. A field present in two of them and missing from the third
    // reads as blank, which for notes means every lead would look like an
    // empty note taking Buildertrend's — the exact overwrite this rule exists
    // to prevent.
    notes: str(row.notes),
    // The lead <-> job link is kept on BOTH sides: leads.job_id and jobs.lead_id.
    // sync-preview.js reads both into has_job, and only through a job of THIS
    // organization — a job_id naming another tenant's job does not count.
    linkedJob: !!row.has_job,
    state86: p86LeadState(row.status),
    // leads.bt_lead_id — set only by sync-apply.js when an admin applies a match.
    btId: row.bt_lead_id == null ? '' : str(row.bt_lead_id).trim(),
  };
}

function leadCand(p, rungs) {
  return { id: p.id, title: p.title, status: p.status, client: p.client,
    street: p.street, city: p.city, state: p.state, zip: p.zip, rungs: [...rungs] };
}

// directory: { users: [{id, name}] (ACTIVE users of this org), clients: [{id, name}] (this org) }
function leadProposals(bt, p, directory) {
  const acc = newAcc();
  const notes = [];
  compareField(acc, { field: 'title', label: 'Title', bt: bt.title, p86: p.title, same: (a, b) => textKey(a) === textKey(b) });
  addressFields(acc, bt, p);

  // NOTES. The standing rule of this reconcile at its sharpest: a Buildertrend
  // blank never erases a P86 value, and neither does a Buildertrend sentence
  // somebody in P86 has already written over. So notes FILL and never
  // overwrite — an empty P86 note takes Buildertrend's, and two notes that
  // differ are held back for a person, who is the only one who can tell which
  // is the fuller account rather than merely the later one.
  //
  // Held back and NOT money: it costs nothing to apply and nothing to undo, so
  // it is offered applicable and unticked rather than kept off the page.
  if (isBtBlank(bt.notes)) {
    if (!isP86Blank(p.notes)) acc.btBlank.push({ field: 'notes', label: 'Notes', p86: p.notes });
  } else if (isP86Blank(p.notes)) {
    acc.corrections.push({ field: 'notes', label: 'Notes', kind: 'fill', from: '', to: str(bt.notes).trim() });
  } else if (textKey(bt.notes) !== textKey(p.notes)) {
    acc.heldBack.push({ field: 'notes', label: 'Notes', reason: 'written', money: false, applicable: true,
      bt: str(bt.notes).trim(), p86: str(p.notes).trim(), p86Value: str(p.notes).trim(), value: str(bt.notes).trim(),
      note: 'Both sides carry notes and they differ. Applying REPLACES what Project 86 holds with Buildertrend’s, so it is never automatic — read both and tick it only if Buildertrend’s is the one you want kept.' });
  }

  // NEXT ACTIVITY is shown, not written: Project 86 leads have no column for
  // it, and inventing one to hold three fields on 6 of 75 leads would be a
  // schema decision taken by a sync. It reaches the row as a sentence so the
  // person reading the lead can see it.
  if (!isBtBlank(bt.nextActivityTitle) || !isBtBlank(bt.nextActivityDate)) {
    notes.push('Buildertrend next activity: ' + [str(bt.nextActivityTitle).trim(), str(bt.nextActivityDate).trim(),
      isBtBlank(bt.nextActivityAssignee) ? '' : 'for ' + str(bt.nextActivityAssignee).trim()]
      .filter(Boolean).join(' · ') + '. Project 86 has nowhere to keep this, so nothing is proposed.');
  }

  // SALESPERSON: only onto exactly one active user of this org with that name.
  if (isBtBlank(bt.salesperson)) {
    if (!isP86Blank(p.salesperson)) acc.btBlank.push({ field: 'salesperson', label: 'Salesperson', p86: p.salesperson });
  } else if (personKey(bt.salesperson) !== personKey(p.salesperson)) {
    const hits = (directory.users || []).filter((u) => personKey(u.name) === personKey(bt.salesperson));
    if (hits.length === 1) {
      acc.corrections.push({ field: 'salesperson', label: 'Salesperson', kind: isP86Blank(p.salesperson) ? 'fill' : 'value',
        from: p.salesperson, to: str(bt.salesperson).trim().replace(/\s+/g, ' '), toP86: 'user #' + hits[0].id });
    } else {
      notes.push('Buildertrend salesperson "' + str(bt.salesperson).trim() + '": ' + (hits.length
        ? hits.length + ' active P86 users have that name' : 'no active P86 user in this organization has that name') + ', so nothing is proposed.');
    }
  } else if (str(bt.salesperson).trim().replace(/\s+/g, ' ') !== p.salesperson.trim()) {
    // Same person, written differently in Buildertrend: nothing to change in P86.
  }

  // CONTACT -> CLIENT: only onto exactly one client of this org by name, and
  // never on a lead that already became a job.
  if (isBtBlank(bt.contactName)) {
    if (!isP86Blank(p.client)) acc.btBlank.push({ field: 'client', label: 'Client', p86: p.client });
  } else if (textKey(bt.contactName) !== textKey(p.client)) {
    if (p.linkedJob) {
      notes.push('Buildertrend contact "' + str(bt.contactName).trim() + '" differs from the P86 client, but this lead is already converted to a job, so its client is not proposed.');
    } else {
      const hits = (directory.clients || []).filter((x) => textKey(x.name) === textKey(bt.contactName));
      if (hits.length === 1) {
        acc.corrections.push({ field: 'client', label: 'Client', kind: isP86Blank(p.client) ? 'fill' : 'value',
          from: p.client, to: str(bt.contactName).trim(), toP86: 'client ' + hits[0].id });
      } else {
        notes.push('Buildertrend contact "' + str(bt.contactName).trim() + '": ' + (hits.length
          ? hits.length + ' P86 clients have that name' : 'no P86 client in this organization has that name') + ', so nothing is proposed.');
      }
    }
  }

  compareField(acc, { field: 'source', label: 'Source', bt: bt.source, p86: p.source, same: (a, b) => textKey(a) === textKey(b) });

  // CONFIDENCE: 0 is Buildertrend's blank (40 of 44 leads).
  const conf = typeof bt.confidence === 'number' ? bt.confidence : (isBtBlank(bt.confidence) ? null : Number(bt.confidence));
  const p86Conf = p.confidence === '' ? null : Number(p.confidence);
  if (conf == null || conf === 0) {
    if (p86Conf) acc.btBlank.push({ field: 'confidence', label: 'Confidence', p86: String(p86Conf), zero: conf === 0 });
  } else if (!Number.isFinite(conf)) {
    notes.push('Buildertrend confidence is not a number, so it was not compared.');
  } else if (conf !== p86Conf) {
    acc.corrections.push({ field: 'confidence', label: 'Confidence', kind: p86Conf ? 'value' : 'fill',
      from: p86Conf ? String(p86Conf) : '', to: String(conf) });
  }

  compareMoney(acc, { field: 'estimatedRevenueMin', label: 'Est. revenue (low)', bt: bt.estimatedRevenueMin, p86: p.revenueLow, applicable: true });
  compareMoney(acc, { field: 'estimatedRevenueMax', label: 'Est. revenue (high)', bt: bt.estimatedRevenueMax, p86: p.revenueHigh, applicable: true });

  if (p.state86 === 'closed') {
    acc.flags.push({ field: 'status', label: 'Status',
      text: 'P86 has this lead as "' + p.status + '", but Buildertrend\'s Leads dataset lists only open leads. Buildertrend carries no lead status, so none is proposed.' });
  }
  return { acc, notes };
}

function matchLeads(btValues, p86Rows, ctx) {
  const directory = (ctx && ctx.directory) || { users: [], clients: [] };
  const p86 = p86Rows.map(p86LeadView);
  const byTitle = indexBy(p86, (p) => textKey(p.title));
  const byStreet = indexBy(p86, (p) => streetKey(p.street));
  const near = nearIndex(p86, (p) => p.title);
  const NEAR_LABELS = { name: 'similar title', place: 'same address, typo-tolerant' };
  // Buildertrend's Leads dataset holds OPEN leads only. A P86 lead that is
  // sold/lost/no-opportunity, or already became a job, is not what an open
  // Buildertrend lead normally is; an unknown status counts as open (never assumed closed).
  const isOpen = (p) => p.state86 !== 'closed' && !p.linkedJob;

  const rows = btValues.map((v, i) => {
    const bt = {
      index: i, btId: v.btId, raw: str(v.title), title: str(v.title),
      street: str(v.street), city: str(v.city), state: str(v.state), zip: str(v.zip),
      contactId: str(v.contactId), contactName: str(v.contactName), salesperson: str(v.salesperson), source: str(v.source),
      confidence: v.confidence, estimatedRevenueMin: v.estimatedRevenueMin, estimatedRevenueMax: v.estimatedRevenueMax,
      projectType: str(v.projectType), createdDate: str(v.createdDate), scope: 'open',
      // The SECOND place these were dropped. readLead takes them off the
      // Buildertrend record and this view is built by naming fields one at a
      // time, so a key missing HERE is read and then thrown away again — which
      // is what happened to notes for as long as the leads dataset has existed.
      // bt.notes is Buildertrend's note ON the lead; row.notes, on the row
      // itself, is this matcher's own explanation of what it did. Different
      // objects, and the only two things in this file called notes.
      notes: str(v.notes),
      nextActivityDate: str(v.nextActivityDate),
      nextActivityTitle: str(v.nextActivityTitle),
      nextActivityAssignee: str(v.nextActivityAssignee),
    };
    const view = Object.assign({}, bt);
    delete bt.estimatedRevenueMin;
    delete bt.estimatedRevenueMax;
    if (typeof bt.confidence !== 'number') bt.confidence = bt.confidence == null ? null : str(bt.confidence).slice(0, 20);
    if (isBtBlank(v.title)) return unpairedRow(bt, 'refused', [], ['This Buildertrend lead has no title, so it cannot be matched and will never be created.']);

    // RUNG 0 — THE BUILDERTREND ID (see matchJobs).
    const btKey = v.btId == null ? '' : String(v.btId).trim();
    const linked = btKey ? (p86.filter((p) => p.btId && p.btId === btKey)) : [];
    const linkedIds = new Set(linked.map((p) => p.id));
    const free = (p) => !p.btId || p.btId === btKey;

    const tk = textKey(v.title);
    const titleHits = (byTitle.get(tk) || []).filter(free);
    const sk = streetKey(v.street);
    const placeHits = sk ? (byStreet.get(sk) || []).filter((p) => free(p) && samePlace(bt, p, false)) : [];
    const cands = new Map();
    const add = (list, rung) => {
      for (const p of list) {
        if (!cands.has(p.id)) cands.set(p.id, { p, rungs: new Set() });
        cands.get(p.id).rungs.add(rung);
      }
    };
    add(titleHits.filter((p) => placeHits.includes(p)), 'title + address');
    add(titleHits.filter((p) => !isBtBlank(v.contactName) && textKey(p.client) === textKey(v.contactName)), 'title + client');
    add(titleHits, 'title');
    add(placeHits, 'address');
    // NEAR rungs for every lead (see matchJobs).
    const nearList = near(v.title, bt, (p) => cands.has(p.id) || linkedIds.has(p.id) || !free(p), NEAR_LABELS).map((h) => leadCand(h.it, h.why));
    const allCands = () => [...cands.values()].map((x) => leadCand(x.p, x.rungs)).concat(nearList);
    const confirms = (x) => x.rungs.has('title + address') || x.rungs.has('title + client');
    const amb = (note) => unpairedRow(bt, 'ambiguous', allCands(), [note]);

    if (linked.length > 1) {
      return unpairedRow(bt, 'ambiguous', linked.map((p) => leadCand(p, ['Buildertrend ID'])),
        [linked.length + ' P86 leads are linked to this Buildertrend lead. Nothing is proposed; unlink the extra one.']);
    }
    if (linked.length === 1) {
      const p = linked[0];
      const { acc, notes } = leadProposals(view, p, directory);
      return {
        bt, class: acc.corrections.length ? 'conflict' : 'matched', rung: 'Buildertrend ID', p86: leadCand(p, ['Buildertrend ID']),
        corrections: acc.corrections, btBlank: acc.btBlank, heldBack: acc.heldBack, flags: acc.flags,
        candidates: [], notes, p86Duplicates: [], considered: [],
      };
    }

    if (titleHits.length) {
      const confirmed = [...cands.values()].filter((x) => x.rungs.has('title') && confirms(x));
      if (confirmed.length > 1) {
        return amb(confirmed.length + ' P86 leads share this title and agree on address or client. Nothing is proposed.');
      }
      if (!confirmed.length) {
        return amb('The title matches, but neither the address nor the client confirms it. Nothing is proposed.');
      }
      const p = confirmed[0].p;
      const rung = confirmed[0].rungs.has('title + address') ? 'title + address' : 'title + client';
      const others = [...cands.values()].filter((x) => x.p.id !== p.id);
      // NEVER FIRST-RUNG-WINS. Repeat work reuses titles ("Waterside I Siding
      // Replacement" twice): another OPEN P86 lead with the same title makes the
      // row ambiguous, whichever of the two happens to carry the address.
      const openSameTitle = others.filter((x) => x.rungs.has('title') && isOpen(x.p));
      if (openSameTitle.length) {
        return amb(openSameTitle.length + ' other open P86 lead' + (openSameTitle.length === 1 ? '' : 's') + ' share' + (openSameTitle.length === 1 ? 's' : '')
          + ' this title' + (isOpen(p) ? '' : ', while the one that agrees on ' + (rung === 'title + address' ? 'the address' : 'the client') + ' is "' + (p.status || 'unknown') + '"' + (p.linkedJob ? ' and already a job' : ''))
          + '. Buildertrend lists open leads only and repeat work reuses titles, so nothing is proposed.');
      }
      // Confirmed by the client only, while a DIFFERENT P86 lead sits at the
      // Buildertrend address: that lead may be the real counterpart.
      const atAddress = others.filter((x) => x.rungs.has('address') && !x.rungs.has('title'));
      if (rung === 'title + client' && atAddress.length) {
        return amb('The title and client match one P86 lead, but ' + atAddress.length + ' other P86 lead' + (atAddress.length === 1 ? ' sits' : 's sit')
          + ' at the Buildertrend address (' + placeText(bt) + '). Nothing is proposed.');
      }
      const { acc, notes } = leadProposals(view, p, directory);
      const closedSameTitle = others.filter((x) => x.rungs.has('title'));
      if (closedSameTitle.length) {
        notes.push(closedSameTitle.length + ' other P86 lead' + (closedSameTitle.length === 1 ? '' : 's') + ' with this title '
          + (closedSameTitle.length === 1 ? 'is' : 'are') + ' closed or already a job; only this one agrees on ' + (rung === 'title + address' ? 'the address' : 'the client') + '.');
      }
      if (atAddress.length) {
        notes.push('P86 also has ' + atAddress.length + ' other lead' + (atAddress.length === 1 ? '' : 's') + ' at this address: '
          + atAddress.map((x) => '"' + x.p.title + '"').join(', ') + '. Listed under "also considered".');
      }
      const row = {
        bt, class: acc.corrections.length ? 'conflict' : 'matched', rung, p86: leadCand(p, [rung]),
        corrections: acc.corrections, btBlank: acc.btBlank, heldBack: acc.heldBack, flags: acc.flags,
        candidates: [], notes, p86Duplicates: [],
        // P86 leads this row reached but did not pick (closed same-title leads,
        // other leads at the same address). Shown on the row, and never called
        // absent from Buildertrend.
        considered: others.map((x) => leadCand(x.p, x.rungs)),
      };
      if (nearList.length) {
        row.p86Duplicates = nearList;
        row.flags.push({ field: 'duplicate', label: 'Possible P86 duplicate',
          text: 'P86 also holds ' + nearList.length + ' lead' + (nearList.length === 1 ? '' : 's') + ' that look' + (nearList.length === 1 ? 's' : '')
            + ' like this one: ' + nearList.map((x) => '"' + x.title + '"').join('; ') + '. Nothing about ' + (nearList.length === 1 ? 'it' : 'them')
            + ' is proposed — review for a duplicate in P86.' });
      }
      return row;
    }
    // ONLY THE ADDRESS REACHED ANYTHING. An address is a PROPERTY and a lead is
    // a piece of work at it: AGX does repeat work at the same apartment complex
    // for years, so 21 P86 leads can share this street without one of them being
    // this lead. The address CORROBORATES a title that already matched (the
    // rungs above); on its own it proposes nothing — and refuses nothing either,
    // because refusing here left 31 new leads permanently unclearable.
    const atAddress = [...cands.values()];
    if (atAddress.length) {
      // What the address is still good for. A lead already at this property
      // whose TITLE reads like this one is the same lead worded differently, and
      // that is the duplicate this arm used to prevent by accident.
      const same = atAddress.filter((x) => nearTitles(bt.title, x.p.title));
      const rest = atAddress.filter((x) => same.indexOf(x) === -1);
      // Counts what it LISTS, and says so: on the arm that names one of them as
      // a candidate, the rest are the OTHER leads at that address.
      const alsoNote = (list, picked) => 'P86 holds ' + list.length + (picked ? ' other' : '') + ' lead' + (list.length === 1 ? '' : 's')
        + ' at ' + placeText(bt) + ' (' + list.map((x) => '"' + x.p.title + '"').join(', ')
        + '). An address is a property and a lead is a piece of work at it, so the address alone proposes nothing: '
        + (list.length === 1 ? 'that lead is' : 'those leads are') + ' listed under "also considered".';
      const row = same.length
        ? unpairedRow(bt, 'possible_duplicate',
          same.map((x) => leadCand(x.p, [...x.rungs, 'similar title'])).concat(nearList),
          [same.length + ' P86 lead' + (same.length === 1 ? '' : 's') + ' at this address ' + (same.length === 1 ? 'reads' : 'read')
            + ' like this one worded differently. Review before anything is created.'])
        : nearList.length
          ? unpairedRow(bt, 'possible_duplicate', nearList,
            ['No P86 lead matches exactly, but ' + nearList.length + ' look' + (nearList.length === 1 ? 's' : '') + ' like this one. Review before anything is created.'])
          : unpairedRow(bt, 'new', [], []);
      // The leads at that property are USEFUL CONTEXT, and they are already
      // collected: they stay on the row (and out of "in P86, not in
      // Buildertrend") so a person creating this lead sees what else P86 holds
      // there and can link to one instead.
      row.considered = rest.map((x) => leadCand(x.p, x.rungs));
      if (rest.length) row.notes.push(alsoNote(rest, same.length > 0));
      return row;
    }
    if (nearList.length) {
      return unpairedRow(bt, 'possible_duplicate', nearList,
        ['No P86 lead matches exactly, but ' + nearList.length + ' look' + (nearList.length === 1 ? 's' : '') + ' like this one. Review before anything is created.']);
    }
    return unpairedRow(bt, 'new', [], []);
  });
  demoteCollisions(rows, 'lead');
  return rows;
}

// Two Buildertrend rows landing confidently on ONE P86 record: all ambiguous,
// every proposal cleared.
function demoteCollisions(rows, noun) {
  const claims = new Map();
  for (const r of rows) {
    if ((r.class === 'matched' || r.class === 'conflict') && r.p86) {
      if (!claims.has(r.p86.id)) claims.set(r.p86.id, []);
      claims.get(r.p86.id).push(r);
    }
  }
  for (const group of claims.values()) {
    if (group.length < 2) continue;
    for (const r of group) {
      // Its possible duplicates become candidates like any ambiguous row's.
      r.candidates = [r.p86].concat(r.p86Duplicates || [], r.considered || []);
      r.p86Duplicates = [];
      r.considered = [];
      r.notes.push(group.length + ' Buildertrend ' + noun + 's all land on this same P86 ' + noun + ', so none is counted as matched and nothing is proposed.');
      r.class = 'ambiguous';
      r.p86 = null;
      clearProposals(r);
    }
  }
}

// ── the P86 side: records no Buildertrend row reached ─────────────────────
// A P86 record is REACHED when it is a confident counterpart, or a candidate on
// ANY row (ambiguous, possible duplicate, a collision). Every candidate counts —
// nothing is capped here, so no extra candidate leaks into this list.
// Jobs: only ACTIVE P86 jobs are listed (Completed/Archived are counted);
// a status outside P86's vocabulary is listed as unknown.
// Leads: only OPEN P86 leads are listed; sold/lost/no-opportunity are expected
// absent (Buildertrend's Leads dataset is open leads only) and are counted. One
// still open in P86 that carries the id of a Buildertrend lead NO record of a
// COMPLETE read carried is marked `linkedGone`: Buildertrend sold, lost or
// closed it, so it left the open list. Nothing is proposed for it — "gone from
// the open list" is not a P86 status, and P86 may be right to keep working it.
function notInBuildertrend(rows, p86Rows, kind, opts) {
  // Only a COMPLETE read makes "no Buildertrend record carries this id" mean
  // anything: after a partial read the id may sit in the part never fetched.
  const readComplete = !!(opts && opts.readComplete);
  const btIdsRead = new Set();
  for (const r of rows) {
    const k = r.bt && r.bt.btId != null ? String(r.bt.btId).trim() : '';
    if (k) btIdsRead.add(k);
  }
  const reached = new Set();
  // A possible P86 duplicate next to a confident match is NOT reached (it may be
  // a real P86-only record), but it is linked back to the row it resembles.
  const resembles = new Map();
  for (const r of rows) {
    if (r.p86) reached.add(r.p86.id);
    for (const cand of r.candidates || []) reached.add(cand.id);
    for (const cand of r.considered || []) reached.add(cand.id);
    if (r.parent && r.parent.p86) reached.add(r.parent.p86.id);
    for (const d of r.p86Duplicates || []) {
      if (!resembles.has(d.id)) resembles.set(d.id, []);
      resembles.get(d.id).push({ btIndex: r.bt.index, btRaw: r.bt.raw, matchedTo: r.p86 ? (kind === 'jobs' ? [r.p86.jobNumber, r.p86.title].filter(Boolean).join(' ') : r.p86.title) || r.p86.id : '' });
    }
  }
  const listed = [];
  let notListed = 0;
  const link = (entry) => {
    if (resembles.has(entry.id)) entry.resembles = resembles.get(entry.id);
    return entry;
  };
  if (kind === 'jobs') {
    for (const p of p86Rows.map(p86JobView)) {
      if (reached.has(p.id)) continue;
      if (p.state86 === 'completed' || p.state86 === 'archived') { notListed++; continue; }
      listed.push(link({ id: p.id, jobNumber: p.jobNumber, title: p.title, status: p.status, state86: p.state86 || 'unknown',
        street: p.street, city: p.city, state: p.state, zip: p.zip }));
    }
  } else if (kind === 'clients') {
    // Buildertrend's client-contacts dataset is the whole directory, so every P86
    // client no Buildertrend contact reached is listed.
    for (const p of p86Rows.map(p86ClientView)) {
      if (reached.has(p.id)) continue;
      listed.push(link({ id: p.id, title: p.name, email: p.email, street: p.street, city: p.city, state: p.state, zip: p.zip,
        state86: p.parentId ? 'property' : 'client' }));
    }
  } else {
    for (const p of p86Rows.map(p86LeadView)) {
      if (reached.has(p.id)) continue;
      if (p.state86 === 'closed') { notListed++; continue; }
      listed.push(link({ id: p.id, title: p.title, status: p.status, state86: p.state86 || 'unknown', client: p.client,
        street: p.street, city: p.city, state: p.state, zip: p.zip,
        linkedGone: readComplete && p.btId && !btIdsRead.has(p.btId) ? true : undefined }));
    }
  }
  return { rows: listed, notListed };
}

const RATE_CLASSES = ['matched', 'conflict', 'ambiguous', 'possible_duplicate', 'new'];

function summarise(rows, filter) {
  const keep = filter || (() => true);
  const counts = { matched: 0, conflict: 0, ambiguous: 0, possible_duplicate: 0, new: 0, change_order: 0, not_a_job: 0, refused: 0 };
  let correctedFields = 0;
  let formatOnly = 0;
  let fills = 0;
  let typos = 0;
  let btBlankRecords = 0;
  let btBlankFields = 0;
  let heldBackRecords = 0;
  let flagged = 0;
  let n = 0;
  for (const r of rows) {
    if (!keep(r)) continue;
    n++;
    counts[r.class] = (counts[r.class] || 0) + 1;
    for (const x of r.corrections) {
      correctedFields++;
      if (x.kind === 'format') formatOnly++;
      if (x.kind === 'fill') fills++;
      if (x.typo) typos++;
    }
    if (r.btBlank.length) { btBlankRecords++; btBlankFields += r.btBlank.length; }
    if (r.heldBack.length) heldBackRecords++;
    if (r.flags.length) flagged++;
  }
  const base = RATE_CLASSES.reduce((s, k) => s + counts[k], 0);
  return {
    records: n, counts, correctedFields, formatOnly, fills, typos,
    btBlank: { records: btBlankRecords, fields: btBlankFields },
    heldBack: { records: heldBackRecords }, flagged,
    matchRate: base > 0 ? (counts.matched + counts.conflict) / base : null,
    matchRateBase: base,
  };
}

// ── clients (Buildertrend client contacts) ───────────────────────────────
//
// P86 keeps its own client names (management-company / property splits were
// made in P86 on purpose), so a name is a MATCH KEY, never a correction. Contact
// details follow the owner's rules: a blank P86 email / phone / cell / mailing
// address is filled from Buildertrend; a DIFFERENT value is held back with a box
// a person may tick. Rungs: the Buildertrend id once linked, then the exact name
// (unique on both sides), then a unique email whose names also agree.

function p86ClientView(row) {
  return {
    id: row.id,
    name: str(row.name).trim(),
    title: str(row.name).trim(),
    email: str(row.email).trim(),
    phone: str(row.phone).trim(),
    cell: str(row.cell).trim(),
    street: str(row.address),
    city: str(row.city),
    state: str(row.state),
    zip: str(row.zip),
    parentId: row.parent_client_id == null ? '' : str(row.parent_client_id),
    btId: row.bt_contact_id == null ? '' : str(row.bt_contact_id).trim(),
  };
}

// "CMG Management - Caravel 1": the company is shared by every property it
// manages, so similarity is judged on the property part only.
function clientCore(name) {
  const parts = str(name).split(/\s+[-\u2013\u2014]\s+/).map((x) => x.trim()).filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 1] : str(name).trim();
}

// Words every community name uses. Two names that share only these (and look
// alike letter by letter) are different properties: "Westwinds Condominiums"
// is not "Eastwinds Condominiums".
const CLIENT_GENERIC = new Set(('condo condos condominium condominiums apartment apartments apts association assoc hoa coa poa '
  + 'towers tower villas villa village villages estates estate homes townhomes townhouses '
  + 'management mgmt property properties community communities inc llc corp').split(' '));

// Does a near-looking client name really look like the same property? The
// property parts must share a word that is neither generic nor a number, and
// any numbers they carry must be the same ("Caravel 1" is not "Caravel 2").
function sameClientProperty(a, b) {
  const words = (s) => tokens(s);
  // textKey keeps the single digits tokens() drops ("Caravel 1").
  const nums = (s) => textKey(s).split(' ').filter((w) => /^\d+$/.test(w)).sort().join(' ');
  if (nums(a) !== nums(b)) return false;
  const special = (s) => [...words(s)].filter((w) => !/^\d+$/.test(w) && !GENERIC.has(w) && !CLIENT_GENERIC.has(w));
  const A = special(a);
  const B = special(b);
  return A.some((w) => B.includes(w) || B.some((v) => fuzzyEq(w, v)));
}

function clientCand(p, rungs) {
  return { id: p.id, title: p.name, email: p.email, street: p.street, city: p.city, state: p.state, zip: p.zip, rungs: [...rungs] };
}

function emailKey(v) {
  const s = str(v).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : '';
}

function phoneKey(v) {
  const d = str(v).replace(/\D/g, '');
  const t = d.length === 11 && d[0] === '1' ? d.slice(1) : d;
  return t.length >= 7 ? t : '';
}

// Blank P86 -> fill (a correction). Same after normalising -> nothing (contact
// details carry no formatting-only noise). Different -> held back, tickable.
function contactField(acc, spec) {
  const { field, label, bt, p86 } = spec;
  if (isBtBlank(bt)) {
    if (!isP86Blank(p86)) acc.btBlank.push({ field, label, p86: str(p86) });
    return;
  }
  const to = str(bt).trim().replace(/\s+/g, ' ');
  if (isP86Blank(p86)) {
    acc.corrections.push({ field, label, kind: 'fill', from: '', to });
    return;
  }
  if (spec.same(bt, p86)) return;
  acc.heldBack.push({ field, label, reason: 'differs', bt: to, p86: str(p86).trim(), value: to, applicable: true,
    note: 'P86 already has a different value. Never applied automatically — tick it to replace P86\'s value with Buildertrend\'s.' });
}

function clientProposals(bt, p) {
  const acc = newAcc();
  const notes = [];
  if (!isBtBlank(bt.name) && textKey(bt.name) !== textKey(p.name)) {
    notes.push('Buildertrend names this contact "' + str(bt.name).trim() + '"; P86 keeps its own client name.');
  }
  contactField(acc, { field: 'email', label: 'Email', bt: bt.email, p86: p.email, same: (a, b) => emailKey(a) !== '' && emailKey(a) === emailKey(b) });
  contactField(acc, { field: 'phone', label: 'Phone', bt: bt.phone, p86: p.phone, same: (a, b) => phoneKey(a) !== '' && phoneKey(a) === phoneKey(b) });
  contactField(acc, { field: 'cell', label: 'Cell', bt: bt.cell, p86: p.cell, same: (a, b) => phoneKey(a) !== '' && phoneKey(a) === phoneKey(b) });
  contactField(acc, { field: 'street', label: 'Mailing street', bt: bt.street, p86: p.street, same: (a, b) => streetKey(a) === streetKey(b) });
  contactField(acc, { field: 'city', label: 'City', bt: bt.city, p86: p.city, same: (a, b) => cityKey(a) === cityKey(b) });
  contactField(acc, { field: 'state', label: 'State', bt: bt.state, p86: p.state, same: (a, b) => stateKey(a) === stateKey(b) });
  contactField(acc, { field: 'zip', label: 'Zip', bt: bt.zip, p86: p.zip, same: (a, b) => zipKey(a) === zipKey(b) });
  return { acc, notes };
}

function matchClients(btValues, p86Rows) {
  const p86 = p86Rows.map(p86ClientView);
  const byBtId = indexBy(p86, (p) => p.btId);
  const byName = indexBy(p86, (p) => textKey(p.name));
  const byEmail = indexBy(p86, (p) => emailKey(p.email));
  const near = nearIndex(p86, (p) => clientCore(p.name));
  const NEAR_LABELS = { name: 'similar name', place: 'same mailing address, typo-tolerant' };
  const btNameCount = new Map();
  const btEmailCount = new Map();
  for (const v of btValues) {
    const nk = textKey(v.displayName);
    if (nk) btNameCount.set(nk, (btNameCount.get(nk) || 0) + 1);
    const ek = emailKey(v.email);
    if (ek) btEmailCount.set(ek, (btEmailCount.get(ek) || 0) + 1);
  }

  const rows = btValues.map((v, i) => {
    const bt = {
      index: i, btId: v.btId, raw: str(v.displayName), title: str(v.displayName), name: str(v.displayName),
      email: str(v.email), phone: str(v.phone), cell: str(v.cell),
      street: str(v.street), city: str(v.city), state: str(v.state), zip: str(v.zip),
      jobCount: v.jobCount, leadCount: v.leadCount, scope: 'all',
    };
    if (isBtBlank(v.displayName)) return unpairedRow(bt, 'refused', [], ['This Buildertrend contact has no name, so it cannot be matched and will never be created.']);

    const btKey = v.btId == null ? '' : String(v.btId).trim();
    const linked = btKey ? (byBtId.get(btKey) || []) : [];
    const linkedIds = new Set(linked.map((p) => p.id));
    const free = (p) => !p.btId || p.btId === btKey;
    const nk = textKey(v.displayName);
    const ek = emailKey(v.email);
    const nameHits = nk ? (byName.get(nk) || []).filter(free) : [];
    const emailHits = ek ? (byEmail.get(ek) || []).filter(free) : [];
    const cands = new Map();
    const add = (list, rung) => {
      for (const p of list) {
        if (!cands.has(p.id)) cands.set(p.id, { p, rungs: new Set() });
        cands.get(p.id).rungs.add(rung);
      }
    };
    add(nameHits, 'name');
    add(emailHits, 'email');
    // A shared mailing address is not evidence for clients (a management company
    // shares one across its properties), so no place is passed; a similar name
    // must also agree on a distinctive word of the property part.
    const core = clientCore(v.displayName);
    const nearList = near(core, {}, (p) => cands.has(p.id) || linkedIds.has(p.id) || !free(p), NEAR_LABELS)
      .filter((h) => sameClientProperty(core, clientCore(h.it.name)))
      .map((h) => clientCand(h.it, h.why));
    const allCands = () => [...cands.values()].map((x) => clientCand(x.p, x.rungs)).concat(nearList);
    const amb = (note) => unpairedRow(bt, 'ambiguous', allCands(), [note]);
    const confidentRow = (p, rung, extraNotes) => {
      const { acc, notes } = clientProposals(bt, p);
      const row = {
        bt, class: acc.corrections.length ? 'conflict' : 'matched', rung, p86: clientCand(p, [rung]),
        corrections: acc.corrections, btBlank: acc.btBlank, heldBack: acc.heldBack, flags: acc.flags,
        candidates: [], notes: (extraNotes || []).concat(notes), p86Duplicates: [],
      };
      if (nearList.length) {
        row.p86Duplicates = nearList;
        row.flags.push({ field: 'duplicate', label: 'Possible P86 duplicate',
          text: 'P86 also holds ' + nearList.length + ' client' + (nearList.length === 1 ? '' : 's') + ' that look' + (nearList.length === 1 ? 's' : '')
            + ' like this one: ' + nearList.map((x) => '"' + x.title + '"').join('; ') + '. Nothing about ' + (nearList.length === 1 ? 'it' : 'them') + ' is proposed — review for a duplicate in P86.' });
      }
      return row;
    };

    if (linked.length > 1) {
      return unpairedRow(bt, 'ambiguous', linked.map((p) => clientCand(p, ['Buildertrend ID'])),
        [linked.length + ' P86 clients are linked to this Buildertrend contact. Nothing is proposed; unlink the extra one.']);
    }
    if (linked.length === 1) return confidentRow(linked[0], 'Buildertrend ID');
    if ((btNameCount.get(nk) || 0) > 1) {
      return amb(btNameCount.get(nk) + ' Buildertrend contacts share this name. Nothing is proposed.');
    }
    if (nameHits.length > 1) return amb(nameHits.length + ' P86 clients share this name. Nothing is proposed.');
    if (nameHits.length === 1) {
      const p = nameHits[0];
      // An exact, unique name wins. The same email on other clients is normal for
      // a management company's properties, so it is noted, not a reason to refuse.
      const otherByEmail = emailHits.filter((x) => x.id !== p.id);
      return confidentRow(p, emailHits.some((x) => x.id === p.id) ? 'name + email' : 'name',
        otherByEmail.length ? ['The Buildertrend email is also on ' + otherByEmail.map((x) => '"' + x.name + '"').join(', ') + ' in P86 (often a management company).'] : []);
    }
    if (emailHits.length > 1) return amb(emailHits.length + ' P86 clients share this email. Nothing is proposed.');
    if (emailHits.length === 1) {
      const p = emailHits[0];
      if ((btEmailCount.get(ek) || 0) > 1) {
        return amb('The email matches one P86 client, but ' + btEmailCount.get(ek) + ' Buildertrend contacts share that email (often a management company). Nothing is proposed.');
      }
      if (nameEvidence(v.displayName, p.name) === 'agree') return confidentRow(p, 'email + similar name');
      return amb('Only the email matches, and the names do not agree ("' + str(v.displayName).trim() + '" vs "' + p.name + '"). Nothing is proposed.');
    }
    if (nearList.length) {
      return unpairedRow(bt, 'possible_duplicate', nearList,
        ['No P86 client matches exactly, but ' + nearList.length + ' look' + (nearList.length === 1 ? 's' : '') + ' like this one. Review before anything is created.']);
    }
    return unpairedRow(bt, 'new', [], []);
  });
  demoteCollisions(rows, 'client');
  return rows;
}

module.exports = {
  matchJobs, matchLeads, matchClients, p86ClientView, clientCore, sameClientProperty, emailKey, phoneKey, notInBuildertrend, summarise, RATE_CLASSES,
  parseJobName, exactNumberKey, looseNumberKey, namesAgree, nameEvidence, placeEvidence, streetsMatchStrict, streetsAgree, samePlace,
  nearIndex, nearKey, nearTitles, bigrams, GENERIC,
  isBtBlank, isP86Blank, textKey, streetKey, cityKey, stateKey, zipKey, dateKey, fuzzyEq, osa, charSimilarity,
  parseMoney, fmtMoney, compareField, compareMoney, btJobState, btScope, p86JobState, p86LeadState, btStatusDue,
  p86JobView, p86LeadView, coreTitle, personKey,
};
