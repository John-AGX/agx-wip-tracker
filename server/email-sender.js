// Project 86 outbound sender identity — who an email says it is from, and
// where a reply goes.
//
// Every Resend send carries one verified address (EMAIL_FROM). What varies
// is the display name and the Reply-To:
//
//   platform mail  (credential mail, org invites, the AI spend alarm)
//                  From: EMAIL_FROM verbatim. Reply-To: EMAIL_REPLY_TO env.
//   org mail       (a company talking to its own staff, subs and clients)
//                  From: "AG Exteriors via Project 86" <address from EMAIL_FROM>
//                  Reply-To: the in-org person who caused the mail, or none.
//
// The org name is tenant-controlled free text (an org admin can rename the
// org), so it is sanitised hard before it goes anywhere near a header: CR/LF
// is header injection, bidi overrides and zero-width characters are display
// spoofing, and a tenant calling itself "Project 86 Security" is phishing
// wearing the platform's name. Anything that fails the clean falls back to the
// plain platform sender — a notification is never dropped over a name.
//
// The address part is ALWAYS EMAIL_FROM's address, never org data.
//
// This module is deliberately separate from server/email.js: many suites
// jest.mock('../server/email') with a partial export list, so a route that
// called a new email.js export would get undefined under those mocks. Nothing
// mocks this file, so routes can require it directly for replyToForUser /
// orgNameFor lookups.
//
// Reply-To addresses come from users rows looked up server-side with an org
// predicate — never from a request body and never from the JWT's email claim
// (stale after an email change, and act-as / platform staff sessions carry an
// email that is not a member of the tenant being mailed).

const PLATFORM_NAME = (process.env.EMAIL_PLATFORM_NAME || 'Project 86').trim();

// A bare addr-spec. Deliberately narrower than RFC 5322: no quoted local
// parts, no comments, no whitespace, no header specials. Anything a real
// person's mailbox needs fits; anything that could smuggle a second address
// or a header does not.
const ADDR_SPEC_RE = /^[^\s@<>",;:()\[\]\\]+@[^\s@<>",;:()\[\]\\]+\.[^\s@<>",;:()\[\]\\]+$/;

// Parse EMAIL_FROM into its display name and address. Accepts
//   notifications@project86.net
//   <notifications@project86.net>
//   Project 86 <notifications@project86.net>
//   "Project 86, Inc" <notifications@project86.net>
// Anything else parses to { name: null, address: null } and the caller sends
// EMAIL_FROM verbatim with no branding.
function parseFromEnv(envFrom) {
  const out = { name: null, address: null };
  if (typeof envFrom !== 'string') return out;
  const raw = envFrom.trim();
  if (!raw || /[\r\n]/.test(raw)) return out;
  const angled = /^(.*?)\s*<\s*([^\s<>"]+@[^\s<>"]+)\s*>$/.exec(raw);
  if (angled) {
    if (!/^[^\s@<>",;]+@[^\s@<>",;]+$/.test(angled[2])) return out;
    let name = angled[1].trim();
    if (name.length >= 2 && name.charAt(0) === '"' && name.charAt(name.length - 1) === '"') {
      name = name.slice(1, -1).replace(/\\(.)/g, '$1');
    }
    name = name.trim();
    out.name = name || null;
    out.address = angled[2];
    return out;
  }
  if (/^[^\s@<>",;]+@[^\s@<>",;]+$/.test(raw)) out.address = raw;
  return out;
}

// ── org names that may stand in a From header ────────────────────────
//
// A tenant must not be able to pass as the platform. Comparing the typed text
// against "Project 86" is not enough, because a reader compares GLYPHS, and
// the first version of this check (a lowercase letters-and-digits squash)
// let all of these through as branded mail:
//   - "Pr<Cyrillic o>ject 86 Security", "Pr0ject 86 Support", "P<small-cap
//     R>oject 86": look-alike letters and digits read as the platform name.
//   - "Project <Arabic-Indic 8><Arabic-Indic 6>": 86 in another script's
//     decimal digits.
//   - U+3164 HANGUL FILLER and U+2800 BRAILLE PATTERN BLANK are a letter and a
//     symbol, not format characters, so a Cf strip keeps them. One between
//     two letters of "Project" hid the match; a name made only of them was a
//     blank company; "ACME" plus 55 of them pushed " via Project 86" out of
//     sight in an inbox list.
//
// So the platform-name comparison runs on a SKELETON of the name (the idea
// of Unicode TR39's skeleton, cut down to what a display name needs): hidden
// characters dropped, NFKC, accents dropped, each look-alike folded to the
// Latin letter or ASCII digit it passes for, every decimal digit of any script
// read as its ASCII value, the digits 0 1 3 4 5 7 read as the letters o l e a s
// t, and everything but letters and digits squashed out. The disguised names
// above all come out as "project86...".
//
// orgNameProblem is THE rule. The save-time routes (create, rename, invite)
// call it on what the admin typed; cleanOrgName calls it on the sanitised
// name at send time. One function, so the two checks cannot drift apart.
//
// KNOWN LIMITS, stated rather than hidden: multi-character look-alikes ("rn"
// for "m", "vv" for "w") and plain respellings ("P86 Security", "Project
// Eighty-Six") are not caught, and no table covers every script. What always
// holds is the address: every From is the platform's own verified address
// and ends "via Project 86".

// Parse a space-separated list of hex code points into an array of numbers.
// The tables below are spelled in hex, never in the characters themselves: a
// table of homoglyphs written in homoglyphs cannot be reviewed.
function hexList(s) {
  return String(s).trim().split(/\s+/).map((h) => parseInt(h, 16));
}

// Look-alikes, keyed by the Latin letter (or ASCII digit) each one passes for.
// Upper- and lower-case forms are both listed where both deceive; a
// character's own entry wins, then its lowercase, then its uppercase (so
// Cherokee's lowercase letters find their uppercase entries). "i" and "l"
// are one class — "I" and "l" share a glyph in most sans-serif faces — so
// both skeletonise to "l".
const LOOKALIKE_SOURCES = {
  // Cyrillic, Greek, IPA / small capitals, Cherokee, Lisu, Coptic, Armenian.
  a: '0430 0410 03B1 0391 0251 237A 1D00 13AA A4EE',
  b: '042C 044C 0412 0432 0392 03B2 0299 13F4 A4D0 0184 0185',
  c: '0441 0421 03F2 03F9 1D04 13DF A4DA 2CA5 2CA4',
  d: '0501 13A0 A4D3 1D05',
  e: '0435 0415 03B5 0395 04BD 0454 0404 1D07 13AC A4F0 212E',
  f: '03DC A4DD',
  g: '0261 0262 0581 050D 13C0 A4D6',
  h: '04BB 041D 043D 0397 0570 13BB A4E7 029C',
  j: '0458 0408 03F3 037F 0237 1D0A 13AB A4D9',
  k: '041A 043A 039A 03BA 1D0B 13E6 A4D7',
  l: '0069 0456 0406 03B9 0399 0131 026A 04CF 04C0 01C0 A4F2 029F 13DE A4E1',
  m: '041C 043C 039C 1D0D 13B7 A4DF',
  n: '039D 03B7 0578 0274 A4E0 043F',
  // 0665 is ARABIC-INDIC DIGIT FIVE, a small circle: its glyph, not its
  // value, is what a reader sees.
  o: '043E 041E 03BF 039F 03C3 0585 0555 1D0F 2C9F 2C9E A4F3 04E9 04E8 00F8 00D8 0665',
  p: '0440 0420 03C1 03A1 1D18 13E2 A4D1 2CA3 2CA2',
  q: '051B 051A',
  r: '0433 0280 1D26 13A1 A4E3 2C85',
  s: '0455 0405 A731 13DA A4E2',
  t: '0422 0442 03A4 03C4 1D1B 13A2 A4D4',
  u: '03C5 057D 1D1C A4F4',
  v: '03BD 0475 0474 1D20 13D9 A4E6',
  w: '051D 051C 1D21 13B3 A4EA 03C9',
  x: '0445 0425 03C7 03A7 A4EB 2CAD 2CAC',
  y: '0443 0423 04AE 04AF 03B3 03A5 028F 13A9 A4EC',
  z: '0396 1D22 13C3 A4DC',
  // Glyphs that pass for the digits in "86". Bengali and Gurmukhi FOUR look
  // like an 8, so their glyph beats their value here too.
  8: '0222 0223 09EA 0A6A',
  6: '0431 13EE 2CD3'
};
const LOOKALIKES = new Map();
Object.keys(LOOKALIKE_SOURCES).forEach((target) => {
  hexList(LOOKALIKE_SOURCES[target]).forEach((cp) => LOOKALIKES.set(String.fromCodePoint(cp), target));
});

// The digits a reader takes for letters ("Pr0ject", "Proj3ct").
const DIGIT_LETTERS = { 0: 'o', 1: 'l', 3: 'e', 4: 'a', 5: 's', 7: 't' };

// Characters that draw nothing, or only blank space, yet are not format
// characters, so a \p{Cf} strip keeps them:
//   - every Default_Ignorable_Code_Point: the Hangul fillers U+115F U+1160
//     U+3164 U+FFA0, the Khmer inherent vowels U+17B4 U+17B5, U+034F, U+180E,
//     the tag block — EXCEPT variation selectors, which only restyle the
//     character before them (the emoji form of a pasted coffee cup), cannot
//     draw a blank on their own, and are harmless in a header;
//   - blank symbols that are ordinary So / Lo characters: U+2800 BRAILLE
//     PATTERN BLANK, U+1D159 MUSICAL SYMBOL NULL NOTEHEAD, U+13441 and U+13442
//     EGYPTIAN HIEROGLYPH FULL BLANK and HALF BLANK.
const BLANK_SYMBOLS = new Set(hexList('2800 1D159 13441 13442'));
const DEFAULT_IGNORABLE_RE = /\p{Default_Ignorable_Code_Point}/u;
const VARIATION_SELECTOR_RE = /\p{Variation_Selector}/u;

// Returns 'blank' for a blank symbol, 'hidden' for a zero-width filler, or
// null for anything else.
function hiddenKind(ch) {
  if (BLANK_SYMBOLS.has(ch.codePointAt(0))) return 'blank';
  if (DEFAULT_IGNORABLE_RE.test(ch) && !VARIATION_SELECTOR_RE.test(ch)) return 'hidden';
  return null;
}

// Blank symbols become `blankWith` (they take up a space's width); hidden
// fillers are removed.
function replaceHidden(s, blankWith) {
  let out = '';
  for (const ch of s) {
    const kind = hiddenKind(ch);
    out += kind === 'blank' ? blankWith : (kind === 'hidden' ? '' : ch);
  }
  return out;
}

function hasHidden(s) {
  for (const ch of s) {
    if (hiddenKind(ch)) return true;
  }
  return false;
}

// A decimal digit of any script, as its ASCII value. Unicode assigns every
// Nd digit in contiguous runs of ten, 0 through 9, so the value is the
// distance from the start of the run, mod 10 (mod, because a few runs sit
// back to back, e.g. the mathematical digit sets).
const DECIMAL_DIGIT_RE = /\p{Nd}/u;
function asciiDigit(ch) {
  const cp = ch.codePointAt(0);
  let start = cp;
  while (start > 0 && DECIMAL_DIGIT_RE.test(String.fromCodePoint(start - 1))) start--;
  return String((cp - start) % 10);
}

// Controls, format characters, lone surrogates and hidden fillers, all gone.
function stripInvisible(s) {
  return replaceHidden(s.replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu, ''), '');
}

// Accents off (NFD, then every combining mark dropped), then each character
// to its look-alike's target, or to its own lowercase.
function foldLookalikes(s) {
  try { s = s.normalize('NFD'); } catch (_) { /* malformed input: fold as is */ }
  s = s.replace(/\p{M}+/gu, '');
  let out = '';
  for (const ch of s) {
    let m = LOOKALIKES.get(ch);
    if (m === undefined) {
      const lower = ch.toLowerCase();
      m = LOOKALIKES.get(lower);
      if (m === undefined) m = LOOKALIKES.get(ch.toUpperCase());
      if (m === undefined) m = lower;
    }
    out += m;
  }
  return out;
}

// The comparison key for a name: see the block comment above. Not a display
// value — it is lowercase, accent-free and deliberately lossy.
//
// The look-alike fold runs on either side of NFKC. Before it, because NFKC
// rewrites some look-alikes into characters that no longer look like the
// letter they passed for (Greek lunate sigma, which reads as a "c", becomes a
// final sigma). After it, because NFKC is what turns fullwidth and
// mathematical letters (U+FF30, U+1D40F, both a "P") into characters the table knows.
function skeleton(name) {
  let s = foldLookalikes(stripInvisible(String(name == null ? '' : name)));
  try { s = s.normalize('NFKC'); } catch (_) { /* malformed input: fold as is */ }
  s = foldLookalikes(stripInvisible(s));
  return s
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .replace(/\p{Nd}/gu, asciiDigit)
    .replace(/[013457]/g, (d) => DIGIT_LETTERS[d]);
}

const PLATFORM_KEYS = ['project86', skeleton(PLATFORM_NAME)].filter(Boolean);

// Refuse an organization name that cannot safely become a sender name.
// Returns the reason (a message that starts "name "), or null when the name
// is acceptable. Length and emptiness stay the callers' own checks.
//
//   - control characters (CR/LF/TAB, C1) and line separators: header
//     injection, and nothing a company name needs;
//   - bidi overrides/isolates, zero-width and other format characters:
//     display spoofing (U+202E flips the rest of the name);
//   - hidden fillers and blank symbols (above): a blank or padded name;
//   - no letter at all: nothing that names a company;
//   - the platform's own name, compared by skeleton.
function orgNameProblem(name) {
  const s = String(name == null ? '' : name);
  if (/[\p{Cc}\p{Zl}\p{Zp}]/u.test(s)) {
    return 'name cannot contain line breaks, tabs or control characters';
  }
  if (/[\p{Cf}]/u.test(s)) {
    return 'name cannot contain invisible formatting characters (bidi overrides, zero-width characters)';
  }
  let folded = s;
  try { folded = s.normalize('NFKC'); } catch (_) { /* malformed input: test as is */ }
  if (hasHidden(s) || hasHidden(folded)) {
    return 'name cannot contain invisible or blank filler characters (Hangul fillers, blank Braille patterns)';
  }
  if (!/\p{L}/u.test(folded)) {
    return 'name must contain at least one letter';
  }
  const key = skeleton(s);
  if (PLATFORM_KEYS.some((k) => key.indexOf(k) !== -1)) {
    return 'name cannot include "' + PLATFORM_NAME + '" — organization mail is sent as "<your organization> via ' + PLATFORM_NAME + '"';
  }
  return null;
}

// Sanitise a tenant-controlled org name for use as a display name.
// Returns the cleaned name, or null when it must not be used.
function stripUnsafe(s) {
  s = s
    // C0 / DEL / C1 controls (CR, LF, TAB included) and line/paragraph
    // separators: header-injection defence. Become a space so "AG\nExteriors"
    // still reads as two words.
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ')
    // Format characters: bidi embeddings/overrides/isolates (U+202A-202E,
    // U+2066-2069), zero-width space/joiners, BOM, soft hyphen. Removed
    // outright — they are invisible and exist here only to spoof. Lone
    // surrogates go too so the header always encodes.
    .replace(/[\p{Cf}\p{Cs}]/gu, '');
  // Hidden fillers go the same way; a blank symbol becomes a space, so a
  // padding run collapses to nothing.
  return replaceHidden(s, ' ');
}

function cleanOrgName(name) {
  if (name == null) return null;
  const typed = stripUnsafe(String(name));
  let s = typed;
  try { s = s.normalize('NFKC'); } catch (_) { /* malformed input: keep as is */ }
  s = stripUnsafe(s)
    // Quoted-string breakers and address lookalikes. NFKC above has already
    // folded fullwidth forms into these ASCII characters.
    .replace(/[<>"\\@]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return null;
  // The same rule the save-time routes apply. Everything it refuses outright
  // at save (controls, format characters, fillers) is already stripped here,
  // so what can still fail is a name with no letter or one that spells the
  // platform. It runs on the name as it will be displayed AND on the name as
  // typed: NFKC can rewrite a look-alike into something the table no longer
  // knows (a lunate sigma "c" becomes a final sigma), and save time judged
  // the typed form.
  if (orgNameProblem(s) || orgNameProblem(typed)) return null;
  // Cap by code point, never by UTF-16 unit, so a cut never splits a
  // surrogate pair. A cut can drop the only letters, so check again.
  const cps = Array.from(s);
  if (cps.length > 60) {
    s = cps.slice(0, 60).join('').trim();
    if (!s || orgNameProblem(s)) return null;
  }
  return s;
}

function quoteDisplayName(s) {
  return '"' + String(s).replace(/[\\"]/g, '\\$&') + '"';
}

// Build the From header. A usable org name yields
//   "<Org> via <PLATFORM_NAME>" <address from EMAIL_FROM>
// otherwise EMAIL_FROM is returned exactly as configured. The org goes first
// so a narrow inbox list truncates the platform suffix, not the company.
function fromHeader(envFrom, orgName) {
  const org = cleanOrgName(orgName);
  if (!org) return envFrom;
  const parsed = parseFromEnv(envFrom);
  if (!parsed.address) return envFrom;
  const platform = String(PLATFORM_NAME).replace(/[\r\n]/g, ' ').trim() || 'Project 86';
  return quoteDisplayName(org + ' via ' + platform) + ' <' + parsed.address + '>';
}

// Pull the bare address out of a recipient entry that may be
// "Name <addr>" or a plain addr.
function bareAddress(entry) {
  const s = String(entry == null ? '' : entry).trim();
  const m = /<\s*([^<>\s]+)\s*>\s*$/.exec(s);
  return (m ? m[1] : s).toLowerCase();
}

// Validate one Reply-To address. Null when it is not a single plain
// addr-spec, or when it would point a reply back at one of the recipients
// (replying to yourself is noise, and it hides a misconfigured caller).
function cleanReplyTo(addr, toList) {
  if (typeof addr !== 'string') return null;
  if (/[\r\n]/.test(addr)) return null;
  const s = addr.trim();
  if (!s || s.length > 254) return null;
  if (!ADDR_SPEC_RE.test(s)) return null;
  const lower = s.toLowerCase();
  const list = Array.isArray(toList) ? toList : (toList == null ? [] : [toList]);
  for (let i = 0; i < list.length; i++) {
    if (bareAddress(list[i]) === lower) return null;
  }
  return s;
}

// ── org name lookup ──────────────────────────────────────────────────
// One PK read per org, cached in-process for five minutes. Renames are rare
// and a stale display name for a few minutes is harmless. Misses and errors
// are not cached, and nothing here ever throws — a failed lookup just means
// the plain platform sender.
const ORG_NAME_TTL_MS = 5 * 60 * 1000;
const _orgNameCache = new Map();

async function orgNameFor(db, orgId) {
  if (orgId == null || orgId === '') return null;
  if (!db || typeof db.query !== 'function') return null;
  const key = String(orgId);
  const hit = _orgNameCache.get(key);
  if (hit && (Date.now() - hit.at) < ORG_NAME_TTL_MS) return hit.name;
  try {
    const r = await db.query('SELECT name FROM organizations WHERE id = $1', [orgId]);
    const row = r && r.rows && r.rows[0];
    const name = row && typeof row.name === 'string' && row.name.trim() ? row.name : null;
    if (name) _orgNameCache.set(key, { name: name, at: Date.now() });
    return name;
  } catch (e) {
    return null;
  }
}

function _clearOrgNameCache() {
  _orgNameCache.clear();
}

// ── reply-to lookups ─────────────────────────────────────────────────
// The FRESH users row, predicated on the org being mailed. A platform
// admin acting as a tenant, or a user who has since moved org or been
// deactivated, returns null — their address never lands on that tenant's
// mail.
async function replyToForUser(db, userId, orgId) {
  if (userId == null || userId === '' || orgId == null || orgId === '') return null;
  if (!db || typeof db.query !== 'function') return null;
  try {
    const r = await db.query(
      'SELECT email FROM users WHERE id = $1 AND organization_id = $2 AND active = TRUE',
      [userId, orgId]
    );
    const row = r && r.rows && r.rows[0];
    return row ? cleanReplyTo(row.email, []) : null;
  } catch (e) {
    return null;
  }
}

// For automated org mail whose copy invites a reply (cert_expiring: "reply
// to this email with an updated copy") there is no human author. Use the
// org's earliest-created active admin — normally the owner who set the org
// up. system_admin counts only when that user's own organization_id equals
// this org (the single-tenant bootstrap promotes the founding admin in place);
// platform staff acting as another tenant are not stamped with its id, so
// the predicate keeps them out.
async function replyToForOrgAdmin(db, orgId) {
  if (orgId == null || orgId === '') return null;
  if (!db || typeof db.query !== 'function') return null;
  try {
    const r = await db.query(
      `SELECT email FROM users
        WHERE organization_id = $1
          AND active = TRUE
          AND role IN ('admin', 'system_admin')
          AND email IS NOT NULL AND email <> ''
        ORDER BY created_at ASC, id ASC
        LIMIT 1`,
      [orgId]
    );
    const row = r && r.rows && r.rows[0];
    return row ? cleanReplyTo(row.email, []) : null;
  } catch (e) {
    return null;
  }
}

module.exports = {
  PLATFORM_NAME,
  parseFromEnv,
  skeleton,
  orgNameProblem,
  cleanOrgName,
  fromHeader,
  cleanReplyTo,
  orgNameFor,
  replyToForUser,
  replyToForOrgAdmin,
  _clearOrgNameCache
};
