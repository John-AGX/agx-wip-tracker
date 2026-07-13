// Email Dropbox — inbound email → assistant visibility, with ZERO
// Azure/Graph dependency (the workaround while Outlook admin consent
// is stuck; the Graph integration stays wired for later).
//
// Flow: the user creates an Outlook rule that REDIRECTS (best — the
// dropbox address rides the SMTP envelope so the original headers +
// real sender survive) or forwards a copy of incoming mail to their
// private dropbox address (<inbound_email_key>@INBOUND_EMAIL_DOMAIN).
// Resend receives the domain's mail and POSTs an email.received event
// (svix-signed) to POST /api/email-inbox/inbound.
//
// IMPORTANT — Resend's email.received webhook is METADATA-ONLY (docs:
// resend.com/docs/webhooks/emails/received). The payload's data carries
// { email_id, from, to, cc, bcc, received_for, message_id, subject,
// attachments } and NO body/headers. So the handler:
//   1. verifies the svix signature,
//   2. matches the dropbox owner via received_for (the ENVELOPE
//      recipient — where a redirected message's dropbox address lives)
//      then to/cc/bcc as a fallback,
//   3. FETCHES the full message (text/html/real headers) from the
//      Received Emails API — GET /emails/receiving/{email_id} with the
//      RESEND_API_KEY — because the webhook alone has no body,
//   4. stitches it into a thread and stores it.
//
// Mount order: index.js mounts the inbound webhook (express.raw, so the
// svix signature can verify over the raw bytes) BEHIND a per-IP rate
// limiter and BEFORE the global express.json. The reads below are
// normal authed JSON routes.
//
// Privacy: the dropbox is PERSONAL. Every read is scoped by
// user_id = req.user.id — the REAL authenticated user — so, like DMs
// and Outlook, it is excluded from admin act-as by construction.

const express = require('express');
const crypto = require('crypto');
const { pool } = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();

function inboundDomain() {
  return process.env.INBOUND_EMAIL_DOMAIN || 'in.project86.net';
}
// The dropbox needs BOTH the webhook secret (to accept deliveries) and
// the API key (to fetch bodies). Report configured only when both exist.
function dropboxConfigured() {
  return !!process.env.RESEND_INBOUND_WEBHOOK_SECRET && !!process.env.RESEND_API_KEY;
}

// ── Svix signature verification (Resend signs webhooks via svix) ────
// signedContent = "<svix-id>.<svix-timestamp>.<raw body>", HMAC-SHA256
// with the base64-decoded secret (after the "whsec_" prefix), compared
// against each space-delimited "v1,<base64sig>" entry.
function verifySvix(req) {
  const secret = process.env.RESEND_INBOUND_WEBHOOK_SECRET || '';
  if (!secret) return { ok: false, code: 503, error: 'RESEND_INBOUND_WEBHOOK_SECRET not configured' };
  const id = req.get('svix-id');
  const ts = req.get('svix-timestamp');
  const sigHeader = req.get('svix-signature');
  if (!id || !ts || !sigHeader) return { ok: false, code: 401, error: 'missing signature headers' };
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum) || Math.abs(Date.now() / 1000 - tsNum) > 300) {
    return { ok: false, code: 401, error: 'stale webhook timestamp' };
  }
  let key;
  try { key = Buffer.from(String(secret).replace(/^whsec_/, ''), 'base64'); }
  catch (e) { return { ok: false, code: 503, error: 'bad webhook secret' }; }
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body || '');
  const expected = crypto.createHmac('sha256', key).update(`${id}.${ts}.${raw}`).digest('base64');
  const expectedBuf = Buffer.from(expected);
  const match = String(sigHeader).split(/\s+/).some((entry) => {
    const v = entry.split(',')[1];
    if (!v) return false;
    const vBuf = Buffer.from(v);
    // timingSafeEqual requires equal lengths; the length compare itself
    // is not secret (base64 sig length is fixed), so this is safe.
    if (vBuf.length !== expectedBuf.length) return false;
    try { return crypto.timingSafeEqual(vBuf, expectedBuf); } catch (e) { return false; }
  });
  return match ? { ok: true } : { ok: false, code: 401, error: 'signature mismatch' };
}

// ── Address / header helpers ────────────────────────────────────────
function addrToString(a) {
  if (a == null) return '';
  if (typeof a === 'string') return a;
  if (typeof a === 'object') {
    if (a.email) return a.name ? `${a.name} <${a.email}>` : String(a.email);
    if (a.address) return a.name ? `${a.name} <${a.address}>` : String(a.address);
  }
  return String(a);
}
function extractEmail(s) {
  const str = addrToString(s);
  const angle = str.match(/<([^<>\s]+@[^<>\s]+)>/);
  if (angle) return angle[1].toLowerCase();
  const bare = str.match(/([^\s<>",;]+@[^\s<>",;]+\.[^\s<>",;]+)/);
  return bare ? bare[1].toLowerCase() : '';
}
function extractName(s) {
  const str = addrToString(s);
  const m = str.match(/^\s*"?([^"<]+?)"?\s*</);
  return m ? m[1].trim() : '';
}
function toAddressList(v) {
  if (v == null) return [];
  const arr = Array.isArray(v) ? v : [v];
  return arr.map(extractEmail).filter(Boolean);
}
// Fetched headers come back as an object (possibly with array values for
// repeated headers). Normalize to a lowercase-keyed lookup where a
// repeated header collapses to its LAST value (References/In-Reply-To
// are single-valued in practice; last wins if duplicated).
function headerLookup(h) {
  const out = {};
  if (Array.isArray(h)) {
    h.forEach((e) => { if (e && e.name) out[String(e.name).toLowerCase()] = String(e.value == null ? '' : e.value); });
  } else if (h && typeof h === 'object') {
    Object.keys(h).forEach((k) => {
      const val = h[k];
      out[k.toLowerCase()] = Array.isArray(val) ? String(val[val.length - 1] == null ? '' : val[val.length - 1]) : String(val == null ? '' : val);
    });
  }
  return out;
}
// A Message-ID is only usable if it looks like a real <local@domain>
// token. Degenerate values (<>, <unavailable>, whitespace) return null
// so they never seed false-positive dedupe or thread merges.
function normalizeMsgId(s) {
  if (!s) return null;
  const m = String(s).match(/<[^<>]*@[^<>]*>/);
  if (m) return m[0];
  const bare = String(s).trim().replace(/^<|>$/g, '');
  return /@/.test(bare) ? '<' + bare + '>' : null;
}
function parseRefIds(s) {
  if (!s) return [];
  return (String(s).match(/<[^<>]*@[^<>]*>/g) || []);
}
function normalizeSubject(s) {
  return String(s || '')
    .replace(/^\s*((re|fw|fwd|aw|sv)\s*:\s*)+/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}
// Recover the ORIGINAL sender from a user's own FW: quoted block — the
// first "From: Name <email>" line inside the body. Only trusted when the
// message genuinely came FROM the user's own address (a self-forward);
// never on subject text alone, or an outsider could inject a fake sender.
function recoverForwardedSender(bodyText) {
  const m = String(bodyText || '').match(/^\s*>?\s*\*?From:\*?\s*(.+)$/m);
  if (!m) return null;
  return extractEmail(m[1]) || null;
}
function newId(prefix) {
  return prefix + '_' + Date.now().toString(36) + crypto.randomBytes(5).toString('hex');
}

// ── Fetch the full message body + headers from the Received Emails API.
// The webhook is metadata-only; this is where body_text/html + the real
// RFC threading headers come from. Returns null on any failure (the
// caller then stores what metadata it has rather than dropping the mail).
async function fetchReceivedEmail(emailId) {
  const key = process.env.RESEND_API_KEY;
  if (!key || !emailId) return null;
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 10000);
    const resp = await fetch('https://api.resend.com/emails/receiving/' + encodeURIComponent(emailId), {
      headers: { Authorization: 'Bearer ' + key },
      signal: ctrl.signal,
    });
    clearTimeout(to);
    if (!resp.ok) { console.warn('[email-inbox] retrieve failed', resp.status, 'for', emailId); return null; }
    return await resp.json();
  } catch (e) {
    console.warn('[email-inbox] retrieve error for', emailId, '-', e && e.message);
    return null;
  }
}

// ── POST /api/email-inbox/inbound (svix-verified, raw body) ─────────
// Exported separately; index.js mounts it raw, rate-limited, before
// express.json. Always 200 on "not for us" outcomes so Resend doesn't
// retry forever; non-2xx only for signature/config failures (retryable).
async function inboundHandler(req, res) {
  try {
    const sig = verifySvix(req);
    if (!sig.ok) {
      console.warn('[email-inbox] rejected inbound webhook:', sig.error);
      return res.status(sig.code).json({ error: sig.error });
    }
    let evt;
    try { evt = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body || '{}')); }
    catch (e) { return res.status(400).json({ error: 'invalid JSON' }); }
    if (evt.type && evt.type !== 'email.received') return res.json({ ignored: true, reason: 'event type' });
    const d = evt.data || evt;

    // Recipient match: received_for (SMTP envelope — where a REDIRECTED
    // message's dropbox address lives) FIRST, then parsed to/cc/bcc for
    // plain forwards. Track whether the dropbox appeared as a real
    // header recipient (to/cc) → the mail was addressed to the dropbox
    // directly (didn't transit the user's inbox = lower trust).
    const envelopeList = toAddressList(d.received_for);
    const headerList = toAddressList(d.to).concat(toAddressList(d.cc)).concat(toAddressList(d.bcc));
    const domain = inboundDomain().toLowerCase();
    const scanOrder = envelopeList.concat(headerList);
    let user = null, matchedAddress = null;
    for (const addr of scanOrder) {
      const at = addr.indexOf('@');
      if (at < 0) continue;
      const host = addr.slice(at + 1);
      if (host !== domain) continue;
      const key = addr.slice(0, at).replace(/\+.*$/, '');
      const r = await pool.query(
        'SELECT id, organization_id, email FROM users WHERE LOWER(inbound_email_key) = $1 AND active = TRUE LIMIT 1',
        [key.toLowerCase()]
      );
      if (r.rows.length) { user = r.rows[0]; matchedAddress = addr; break; }
    }
    if (!user) {
      console.warn('[email-inbox] no active user match for:', scanOrder.join(', ') || '(no recipients)');
      return res.json({ ignored: true, reason: 'no matching dropbox' });
    }
    // Direct-delivery = dropbox present in header to/cc/bcc (not only the
    // envelope). Redirected mail carries the dropbox ONLY in received_for.
    const deliveredDirect = headerList.some((a) => {
      const at = a.indexOf('@'); return at > 0 && a.slice(at + 1) === domain && a.slice(0, at).replace(/\+.*$/, '').toLowerCase() === String(matchedAddress).slice(0, String(matchedAddress).indexOf('@')).replace(/\+.*$/, '').toLowerCase();
    });

    const resendEmailId = d.email_id ? String(d.email_id) : null;

    // Dedupe on Resend's own id (always present, unique per delivery).
    // The UNIQUE index makes the INSERT the real guard; this early check
    // just skips the body fetch on an obvious retry.
    if (resendEmailId) {
      const dup = await pool.query('SELECT id FROM inbound_emails WHERE resend_email_id = $1 LIMIT 1', [resendEmailId]);
      if (dup.rows.length) return res.json({ ok: true, deduped: true });
    }

    // Fetch the full message (body + real headers). Webhook alone has none.
    const full = await fetchReceivedEmail(resendEmailId);
    const headers = headerLookup(full && full.headers);
    const fromRaw = (full && full.from) || d.from;
    const subjectRaw = (full && full.subject != null ? full.subject : d.subject);
    const bodyText = String((full && full.text) || '').slice(0, 500000);
    const bodyHtml = String((full && full.html) || '').slice(0, 1000000);

    const subject = String(subjectRaw || '').trim() || '(no subject)';
    // Normalize from the RAW subject so a truly subject-less mail yields
    // '' (skips the subject-fallback stitch) rather than merging every
    // subject-less mail under the literal '(no subject)'.
    const subjectNorm = normalizeSubject(subjectRaw).slice(0, 500);
    const fromEmail = extractEmail(fromRaw);
    const fromName = extractName(fromRaw);
    const messageId = normalizeMsgId(headers['message-id'] || (full && full.message_id) || d.message_id || null);
    const inReplyTo = normalizeMsgId(headers['in-reply-to'] || null);
    const referencesRaw = headers['references'] || '';

    // Self-forward detection: ONLY when the mail is FROM the user's own
    // address (they forwarded it) — recover the quoted original sender.
    // A subject starting "FW:" is NOT sufficient (an outsider could set
    // it and inject a fake From: line in the body).
    const isSelfForward = !!(fromEmail && user.email && fromEmail === String(user.email).toLowerCase());
    const origFrom = isSelfForward ? recoverForwardedSender(bodyText) : null;

    // Thread stitching: real header chain first, else normalized subject
    // within 90 days, else a fresh thread.
    let threadId = null;
    const chainIds = parseRefIds(referencesRaw);
    if (inReplyTo) chainIds.push(inReplyTo);
    if (chainIds.length) {
      const r = await pool.query(
        `SELECT thread_id FROM inbound_emails
          WHERE user_id = $1 AND message_id = ANY($2)
          ORDER BY received_at DESC LIMIT 1`,
        [user.id, chainIds]
      );
      if (r.rows.length) threadId = r.rows[0].thread_id;
    }
    if (!threadId && subjectNorm) {
      const r = await pool.query(
        `SELECT thread_id FROM inbound_emails
          WHERE user_id = $1 AND subject_norm = $2
            AND received_at > NOW() - INTERVAL '90 days'
          ORDER BY received_at DESC LIMIT 1`,
        [user.id, subjectNorm]
      );
      if (r.rows.length) threadId = r.rows[0].thread_id;
    }
    if (!threadId) threadId = newId('th');

    // INSERT ... ON CONFLICT closes the retry race the early SELECT can't.
    const ins = await pool.query(
      `INSERT INTO inbound_emails
         (id, organization_id, user_id, thread_id, resend_email_id, message_id, in_reply_to,
          references_ids, from_name, from_email, orig_from_email, to_email,
          subject, subject_norm, body_text, body_html, is_forward_wrapper, delivered_direct)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       ON CONFLICT (resend_email_id) WHERE resend_email_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [newId('em'), user.organization_id, user.id, threadId, resendEmailId, messageId, inReplyTo,
       String(referencesRaw).slice(0, 5000) || null, fromName || null, fromEmail || null,
       origFrom, matchedAddress, subject, subjectNorm, bodyText, bodyHtml, isSelfForward, deliveredDirect]
    );
    if (!ins.rows.length) return res.json({ ok: true, deduped: true });
    res.json({ ok: true, thread_id: threadId });
  } catch (e) {
    console.error('POST /api/email-inbox/inbound error:', e);
    res.status(500).json({ error: 'Server error' });
  }
}

// ── GET /api/email-inbox/my-address — return (create on first call) ─
router.get('/my-address', requireAuth, async (req, res) => {
  try {
    const u = await pool.query('SELECT inbound_email_key, name, email FROM users WHERE id = $1', [req.user.id]);
    if (!u.rows.length) return res.status(404).json({ error: 'User not found' });
    let key = u.rows[0].inbound_email_key;
    if (!key) {
      const first = String(u.rows[0].name || u.rows[0].email || 'user')
        .split(/[\s@]/)[0].toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12) || 'user';
      for (let attempt = 0; attempt < 5 && !key; attempt++) {
        const candidate = first + '-' + crypto.randomBytes(4).toString('hex').slice(0, 6);
        // Atomic claim: only sets the key if this user still has none.
        // A concurrent caller either lost the race (0 rows, we re-read
        // the winner below) or hit the UNIQUE(inbound_email_key)
        // constraint (throws → caught → retry with a fresh suffix).
        try {
          await pool.query('UPDATE users SET inbound_email_key = $1 WHERE id = $2 AND inbound_email_key IS NULL', [candidate, req.user.id]);
          const check = await pool.query('SELECT inbound_email_key FROM users WHERE id = $1', [req.user.id]);
          key = check.rows[0] && check.rows[0].inbound_email_key;
        } catch (e) { /* unique collision — retry with a new suffix */ }
      }
      if (!key) return res.status(500).json({ error: 'Could not allocate an address' });
    }
    const last = await pool.query('SELECT MAX(received_at) AS last FROM inbound_emails WHERE user_id = $1', [req.user.id]);
    res.json({
      address: key + '@' + inboundDomain(),
      configured: dropboxConfigured(),
      last_received_at: (last.rows[0] && last.rows[0].last) || null,
    });
  } catch (e) {
    console.error('GET /api/email-inbox/my-address error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/email-inbox/threads — the caller's conversations ───────
router.get('/threads', requireAuth, async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 20));
    const q = String(req.query.q || '').trim();
    const params = [req.user.id];
    let where = 'user_id = $1';
    if (q) {
      params.push('%' + q + '%');
      where += ` AND (subject ILIKE $2 OR from_email ILIKE $2 OR COALESCE(orig_from_email, '') ILIKE $2 OR body_text ILIKE $2)`;
    }
    const r = await pool.query(
      `SELECT thread_id,
              COUNT(*)::int AS message_count,
              MAX(received_at) AS last_received_at,
              (ARRAY_AGG(subject ORDER BY received_at DESC))[1] AS subject,
              (ARRAY_AGG(COALESCE(orig_from_email, from_email) ORDER BY received_at DESC))[1] AS last_from,
              (ARRAY_AGG(LEFT(body_text, 200) ORDER BY received_at DESC))[1] AS preview,
              BOOL_OR(delivered_direct) AS has_direct
         FROM inbound_emails
        WHERE ${where}
        GROUP BY thread_id
        ORDER BY last_received_at DESC
        LIMIT ${limit}`,
      params
    );
    res.json({ threads: r.rows });
  } catch (e) {
    console.error('GET /api/email-inbox/threads error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/email-inbox/threads/:threadId — one full conversation ──
// Keeps the NEWEST 100 (subquery DESC) then presents oldest-first.
router.get('/threads/:threadId', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT * FROM (
         SELECT id, thread_id, from_name, from_email, orig_from_email, subject,
                body_text, is_forward_wrapper, delivered_direct, received_at
           FROM inbound_emails
          WHERE user_id = $1 AND thread_id = $2
          ORDER BY received_at DESC LIMIT 100
       ) t ORDER BY received_at ASC`,
      [req.user.id, req.params.threadId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Thread not found' });
    res.json({ messages: r.rows });
  } catch (e) {
    console.error('GET /api/email-inbox/threads/:threadId error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
module.exports.inboundHandler = inboundHandler;
