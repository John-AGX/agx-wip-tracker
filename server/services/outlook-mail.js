// Outlook mail READ (Phase 4) — turns a user's stored OAuth connection into a
// live Microsoft Graph inbox read. STRICTLY read-only + metadata-only:
//   - scope is Mail.ReadBasic (set in msal.js) so the token physically cannot
//     send/delete, and Graph won't return bodies/attachments either.
//   - we $select only sender / subject / received / read-flag / webLink. No
//     body or bodyPreview (Mail.ReadBasic excludes them).
// Token handling: load the user's encrypted MSAL cache, acquireTokenSilent
// (MSAL auto-refreshes + rotates the refresh token), then persist the possibly-
// updated cache back encrypted. Org+user scoped — never another mailbox.
'use strict';

const { pool } = require('../db');
const secretbox = require('../util/secretbox');
const msal = require('./msal');

const GRAPH = 'https://graph.microsoft.com/v1.0';

// Resolve a fresh access token for one user's connected mailbox. Returns
// { token, email } on success, { error } when reconnect/unconfigured/none.
async function getAccessToken(orgId, userId) {
  const { rows } = await pool.query(
    `SELECT token_cache_enc, account_email FROM oauth_tokens
      WHERE organization_id = $1 AND user_id = $2 AND provider = 'microsoft'`,
    [orgId, userId]
  );
  if (!rows.length || !rows[0].token_cache_enc) return { error: 'not_connected' };

  let cache;
  try { cache = secretbox.decrypt(rows[0].token_cache_enc); }
  catch (_) { return { error: 'decrypt_failed' }; }

  const app = msal.newApp(cache);
  let accounts = [];
  try { accounts = await app.getTokenCache().getAllAccounts(); } catch (_) { accounts = []; }
  if (!accounts.length) return { error: 'not_connected' };

  let result;
  try {
    result = await app.acquireTokenSilent({ account: accounts[0], scopes: msal.SCOPES });
  } catch (_) {
    return { error: 'reauth' }; // refresh token expired/revoked — user must reconnect
  }

  // Persist the refreshed/rotated cache so the next read keeps working.
  try {
    const blob = app.getTokenCache().serialize();
    await pool.query(
      `UPDATE oauth_tokens SET token_cache_enc = $3, expires_at = $4, updated_at = NOW()
        WHERE organization_id = $1 AND user_id = $2 AND provider = 'microsoft'`,
      [orgId, userId, secretbox.encrypt(blob), result.expiresOn ? new Date(result.expiresOn) : null]
    );
  } catch (_) { /* best-effort cache write — the read can still proceed */ }

  return { token: result.accessToken, email: rows[0].account_email };
}

// Read the most recent inbox messages (metadata only). opts: { top, unread }.
// Returns { ok, email, count, messages:[{from,fromEmail,subject,received,isRead,webLink}] }
// or { ok:false, error } where error ∈ unconfigured|not_connected|reauth|graph_NNN|graph_unreachable.
async function readInbox(orgId, userId, opts) {
  opts = opts || {};
  if (!orgId || !userId) return { ok: false, error: 'no_user' };
  if (!(msal.isConfigured() && secretbox.isConfigured())) return { ok: false, error: 'unconfigured' };

  const tok = await getAccessToken(orgId, userId);
  if (tok.error) return { ok: false, error: tok.error };

  const top = Math.max(1, Math.min(25, Number(opts.top) || 10));
  const qs = new URLSearchParams();
  qs.set('$top', String(top));
  qs.set('$select', 'subject,from,receivedDateTime,isRead,webLink');
  qs.set('$orderby', 'receivedDateTime desc');
  if (opts.unread) qs.set('$filter', 'isRead eq false');

  let res;
  try {
    res = await fetch(GRAPH + '/me/mailFolders/inbox/messages?' + qs.toString(), {
      headers: { Authorization: 'Bearer ' + tok.token },
    });
  } catch (_) { return { ok: false, error: 'graph_unreachable' }; }

  if (!res.ok) return { ok: false, error: 'graph_' + res.status };
  const data = await res.json().catch(() => ({}));
  const messages = (data.value || []).map((m) => {
    const ea = (m.from && m.from.emailAddress) || {};
    return {
      from: ea.name || ea.address || '(unknown)',
      fromEmail: ea.address || null,
      subject: m.subject || '(no subject)',
      received: m.receivedDateTime || null,
      isRead: !!m.isRead,
      webLink: m.webLink || null,
    };
  });
  return { ok: true, email: tok.email, count: messages.length, messages: messages };
}

module.exports = { readInbox, getAccessToken };
