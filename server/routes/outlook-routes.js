// Outlook / Microsoft 365 connection (Phase 4, READ-ONLY first).
//
// SECURITY POSTURE:
//  - Per-user delegated OAuth. The token belongs to exactly one user in one
//    org; it is OWNER-scoped (organization_id + user_id) and stored ENCRYPTED
//    (server/util/secretbox.js) — no admin, no other user, no cross-org read.
//  - The authorize round-trip is bound to the logged-in user by an encrypted,
//    HttpOnly, SameSite=Lax state cookie (server/util/oauth-state.js): defends
//    login-CSRF and lets the callback identify the user WITHOUT depending on
//    the auth cookie surviving Microsoft's cross-site redirect.
//  - Scope is Mail.ReadBasic only (set in services/msal.js) — the token
//    physically cannot send/forward/delete. There are NO write/send routes here.
//
// Routes:  GET  /api/me/outlook/connect    (authed) -> { url }
//          GET  /auth/microsoft/callback   (state-cookie authed) -> redirect
//          GET  /api/me/outlook/status     (authed) -> { connected, email, ... }
//          DELETE /api/me/outlook          (authed) -> disconnect (local + advisory)
// Mounted at root in server/index.js (the callback path matches MS_REDIRECT_URI).
'use strict';

const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../auth');
const secretbox = require('../util/secretbox');
const oauthState = require('../util/oauth-state');
const msal = require('../services/msal');
const outlookMail = require('../services/outlook-mail');

const router = express.Router();
const PROVIDER = 'microsoft';
const STATE_COOKIE = 'p86_ms_oauth';
const STATE_TTL_MS = 10 * 60 * 1000;          // 10 minutes to complete the flow

function callerOrgId(req) { const o = req.user && req.user.organization_id; return o ? Number(o) : null; }
function callerUserId(req) { return Number(req.user && req.user.id); }
// Both halves of the feature must be configured: the MS app creds AND the
// token-encryption key. Either missing => the connect surface is unavailable
// (but the server still boots — everything here is lazy).
function ready() { return msal.isConfigured() && secretbox.isConfigured(); }

// GET /api/me/outlook/connect — build the Microsoft authorize URL (PKCE S256 +
// state) and set the encrypted state cookie bound to this user.
router.get('/api/me/outlook/connect', requireAuth, async (req, res) => {
  try {
    if (!ready()) return res.status(503).json({ error: 'Outlook integration is not configured on this server yet.' });
    if (!msal.isSingleTenant()) return res.status(500).json({ error: 'Server misconfigured: MS_TENANT must be the AGX tenant GUID, not "common".' });
    const orgId = callerOrgId(req);
    if (!orgId) return res.status(403).json({ error: 'No organization on the current user.' });

    const cp = msal.cryptoProvider();
    const pkce = await cp.generatePkceCodes();         // { verifier, challenge }
    const state = cp.createNewGuid();
    res.cookie(STATE_COOKIE, oauthState.pack(state, pkce.verifier, callerUserId(req), orgId), {
      httpOnly: true, secure: true, sameSite: 'lax', maxAge: STATE_TTL_MS, path: '/',
    });

    const url = await msal.newApp().getAuthCodeUrl({
      scopes: msal.SCOPES,
      redirectUri: msal.redirectUri(),
      state: state,
      codeChallenge: pkce.challenge,
      codeChallengeMethod: 'S256',
      prompt: 'select_account',
    });
    res.json({ url: url });
  } catch (e) {
    console.error('[outlook] connect failed:', e && e.message);
    res.status(500).json({ error: 'Could not start the Outlook connection.' });
  }
});

// GET /auth/microsoft/callback — verify the state cookie, exchange the code,
// and persist the encrypted MSAL token cache. NOT requireAuth: the encrypted
// state cookie (set during the authed /connect) is the authenticator here, so
// this survives Microsoft's cross-site redirect regardless of the auth cookie's
// SameSite policy. A forged/absent cookie fails verification and is rejected.
router.get('/auth/microsoft/callback', async (req, res) => {
  const back = (status) => res.redirect('/?outlook=' + status);
  try {
    const rawCookie = req.cookies && req.cookies[STATE_COOKIE];
    res.clearCookie(STATE_COOKIE, { path: '/' });
    if (req.query.error) { console.warn('[outlook] callback returned error:', req.query.error); return back('denied'); }

    const v = oauthState.verify(rawCookie, req.query.state, STATE_TTL_MS);
    if (!v.ok) { console.warn('[outlook] callback state rejected:', v.reason); return back('state'); }
    if (!req.query.code) return back('nocode');
    if (!ready()) return back('unconfigured');

    const app = msal.newApp();
    const result = await app.acquireTokenByCode({
      scopes: msal.SCOPES,
      redirectUri: msal.redirectUri(),
      code: String(req.query.code),
      codeVerifier: v.verifier,
      state: String(req.query.state),
    });

    // Persist the whole MSAL token cache (holds access + rolling refresh token)
    // as ciphertext — it is the source of truth for later silent refresh. The
    // denormalized columns are for the status UI + refresh scheduling only.
    const cacheBlob = app.getTokenCache().serialize();
    const email = (result && result.account && result.account.username) || null;
    const scope = (result && result.scopes && result.scopes.join(' ')) || msal.SCOPES.join(' ');
    const expiresAt = (result && result.expiresOn) ? new Date(result.expiresOn) : null;

    await pool.query(
      `INSERT INTO oauth_tokens
         (organization_id, user_id, provider, account_email, scope, token_cache_enc, expires_at, connected_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
       ON CONFLICT (organization_id, user_id, provider) DO UPDATE SET
         account_email   = EXCLUDED.account_email,
         scope           = EXCLUDED.scope,
         token_cache_enc = EXCLUDED.token_cache_enc,
         expires_at      = EXCLUDED.expires_at,
         updated_at      = NOW()`,
      [v.org, v.uid, PROVIDER, email, scope, secretbox.encrypt(cacheBlob), expiresAt]
    );
    // TODO(audit): write a connect event to admin_audit_log {uid:v.uid, org:v.org, source:'oauth'}
    return back('connected');
  } catch (e) {
    console.error('[outlook] callback failed:', e && e.message);
    return back('failed');
  }
});

// GET /api/me/outlook/status — connection state for the Settings UI.
router.get('/api/me/outlook/status', requireAuth, async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    if (!orgId) return res.json({ connected: false, configured: ready() });
    const { rows } = await pool.query(
      `SELECT account_email, scope, expires_at, connected_at
         FROM oauth_tokens
        WHERE organization_id = $1 AND user_id = $2 AND provider = $3`,
      [orgId, callerUserId(req), PROVIDER]
    );
    if (!rows.length) return res.json({ connected: false, configured: ready() });
    const r = rows[0];
    res.json({
      connected: true, configured: ready(),
      email: r.account_email, scope: r.scope, connectedAt: r.connected_at,
    });
  } catch (e) {
    console.error('[outlook] status failed:', e && e.message);
    res.status(500).json({ error: 'Could not read Outlook status.' });
  }
});

// DELETE /api/me/outlook — disconnect. Deletes the local token, which stops
// THIS app's access immediately (no token = no Graph calls). Full revocation
// at Microsoft is limited for confidential clients, so the UI tells the user to
// also remove the app at myapps.microsoft.com for a hard revoke.
router.delete('/api/me/outlook', requireAuth, async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    if (!orgId) return res.status(403).json({ error: 'No organization on the current user.' });
    await pool.query(
      `DELETE FROM oauth_tokens WHERE organization_id = $1 AND user_id = $2 AND provider = $3`,
      [orgId, callerUserId(req), PROVIDER]
    );
    // TODO(audit): write a disconnect event to admin_audit_log
    res.json({ ok: true, note: 'Disconnected. To fully revoke access, also remove the app at myapps.microsoft.com.' });
  } catch (e) {
    console.error('[outlook] disconnect failed:', e && e.message);
    res.status(500).json({ error: 'Could not disconnect Outlook.' });
  }
});

// GET /api/me/outlook/messages — read the caller's own inbox (metadata only:
// sender / subject / received / read-flag / webLink). Read-only Mail.ReadBasic.
// Query: top (1-25, default 10), unread=1. Owner-scoped to the caller.
router.get('/api/me/outlook/messages', requireAuth, async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    if (!orgId) return res.status(403).json({ error: 'No organization on the current user.' });
    const out = await outlookMail.readInbox(orgId, callerUserId(req), {
      top: req.query.top,
      unread: String(req.query.unread || '') === '1',
    });
    if (!out.ok) {
      const code = (out.error === 'not_connected' || out.error === 'reauth') ? 409
                 : (out.error === 'unconfigured') ? 503 : 502;
      return res.status(code).json({ error: out.error });
    }
    res.json(out);
  } catch (e) {
    console.error('[outlook] messages failed:', e && e.message);
    res.status(500).json({ error: 'Could not read Outlook mail.' });
  }
});

module.exports = router;
