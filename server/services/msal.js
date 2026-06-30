// msal — Microsoft identity platform config for the per-user Outlook
// connection (Phase 4, read-only). Wraps @azure/msal-node
// ConfidentialClientApplication (the Microsoft-supported path: it handles
// PKCE, the token cache, silent refresh + rolling-refresh-token rotation,
// and Retry-After backoff — better than hand-rolling the HTTP).
//
// Boot-safe: @azure/msal-node is required LAZILY inside newApp()/cryptoProvider()
// and the config comes from env, so the server boots fine before the dependency
// installs or the env vars are set. isConfigured() lets callers gate cleanly.
//
// Scope set: Mail.Read = full read incl. message bodies (so 86 can read an email
// and draft a reply); Mail.Send = send mail on the user's behalf. offline_access
// for a refresh token, openid + User.Read to identify the connected mailbox.
// SAFETY: Mail.Send means there IS an outward API now, so SENDING is never done
// by a tool directly — every send is gated behind a per-send approval card the
// user must confirm in the app (server/routes/outlook-routes.js POST /send/reply
// is only reachable from that confirmed UI action, not auto-tier AI). Reading is
// auto; sending requires an explicit human click.
'use strict';

const SCOPES = ['offline_access', 'openid', 'User.Read', 'Mail.Read', 'Mail.Send'];

function isConfigured() {
  return !!(process.env.MS_CLIENT_ID && process.env.MS_CLIENT_SECRET &&
            process.env.MS_TENANT && process.env.MS_REDIRECT_URI);
}

function authority() {
  return 'https://login.microsoftonline.com/' + (process.env.MS_TENANT || '');
}

function redirectUri() {
  return process.env.MS_REDIRECT_URI || '';
}

// Single-tenant safety: MS_TENANT must be the AGX tenant GUID, never
// 'common'/'organizations'/'consumers' (which would silently reopen the
// multitenant consent surface we are deliberately avoiding).
function isSingleTenant() {
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
    .test(process.env.MS_TENANT || '');
}

// Fresh ConfidentialClientApplication per call so each user's token cache stays
// ISOLATED — never a shared singleton whose one in-memory cache commingles every
// user's mailbox tokens. Pass a user's serialized cache to operate on their
// tokens; omit it for a tokenless call (building the authorize URL).
function newApp(serializedCache) {
  if (!isConfigured()) {
    throw new Error('Outlook not configured (set MS_CLIENT_ID/MS_CLIENT_SECRET/MS_TENANT/MS_REDIRECT_URI).');
  }
  const { ConfidentialClientApplication } = require('@azure/msal-node');
  const app = new ConfidentialClientApplication({
    auth: {
      clientId: process.env.MS_CLIENT_ID,
      clientSecret: process.env.MS_CLIENT_SECRET,
      authority: authority(),
    },
  });
  if (serializedCache) {
    try { app.getTokenCache().deserialize(serializedCache); } catch (_) { /* fail closed: empty cache */ }
  }
  return app;
}

function cryptoProvider() {
  const { CryptoProvider } = require('@azure/msal-node');
  return new CryptoProvider();
}

module.exports = { SCOPES, isConfigured, authority, redirectUri, isSingleTenant, newApp, cryptoProvider };
