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

// Lowercase letters + digits only, so "Project 86", "project86",
// "PROJECT-86" and "P.r.o.j.e.c.t 8 6" all collapse to the same key.
function squash(s) {
  return String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

// Sanitise a tenant-controlled org name for use as a display name.
// Returns the cleaned name, or null when it must not be used.
function cleanOrgName(name) {
  if (name == null) return null;
  let s = String(name);
  try { s = s.normalize('NFKC'); } catch (_) { /* malformed input: keep as is */ }
  s = s
    // C0 / DEL / C1 controls (CR, LF, TAB included) and line/paragraph
    // separators: header-injection defence. Become a space so "AG\nExteriors"
    // still reads as two words.
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ')
    // Format characters: bidi embeddings/overrides/isolates (U+202A-202E,
    // U+2066-2069), zero-width space/joiners, BOM, soft hyphen. Removed
    // outright — they are invisible and exist here only to spoof. Lone
    // surrogates go too so the header always encodes.
    .replace(/[\p{Cf}\p{Cs}]/gu, '')
    // Quoted-string breakers and address lookalikes. NFKC above has already
    // folded fullwidth forms into these ASCII characters.
    .replace(/[<>"\\@]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return null;
  if (!/\p{L}/u.test(s)) return null;
  const key = squash(s);
  if (key.indexOf('project86') !== -1) return null;
  const platformKey = squash(PLATFORM_NAME);
  if (platformKey && key.indexOf(platformKey) !== -1) return null;
  // Cap by code point, never by UTF-16 unit, so a cut never splits a
  // surrogate pair.
  const cps = Array.from(s);
  if (cps.length > 60) s = cps.slice(0, 60).join('').trim();
  return s || null;
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
  cleanOrgName,
  fromHeader,
  cleanReplyTo,
  orgNameFor,
  replyToForUser,
  replyToForOrgAdmin,
  _clearOrgNameCache
};
