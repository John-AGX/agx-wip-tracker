// secretbox — AES-256-GCM authenticated encryption for secrets stored at
// rest (Phase 4: per-user OAuth mailbox tokens in oauth_tokens).
//
// Why this exists: an OAuth refresh token grants full delegated mailbox
// access and is PER-USER, so it must NOT be readable by a tenant/system
// admin or recoverable from a raw DB dump. This is the app's first
// encryption-at-rest. A leaked Postgres dump yields only ciphertext that is
// useless without the key, which lives ONLY in the Railway env var
// M365_TOKEN_ENC_KEY — never in the DB, never in source, never logged.
//
// Design notes:
//  - AES-256-GCM = authenticated encryption: a tampered ciphertext fails
//    CLOSED (decrypt throws) rather than returning garbage.
//  - The key is validated LAZILY (on first encrypt/decrypt), NOT at module
//    load, so a deploy that hasn't set the key yet still BOOTS — the key is
//    only required once a user actually connects a mailbox. (isConfigured()
//    lets callers check without throwing.)
//  - Ciphertext format is versioned for future key rotation:
//        v1:<iv_b64>:<authTag_b64>:<ciphertext_b64>
//    A new key scheme becomes v2: with a dual-read fallback at rotation time.
//
// NEVER log the key or a decrypted token. (Per the secrets-handling rule.)

const crypto = require('crypto');

let _key = null;

// Resolve a 32-byte AES-256 key from M365_TOKEN_ENC_KEY. Accepts a 64-char
// hex string, a 32-byte base64 string, or any >=32-char passphrase (hashed
// to 32 bytes via SHA-256). Throws a clear, actionable error if missing.
function getKey() {
  if (_key) return _key;
  const raw = process.env.M365_TOKEN_ENC_KEY || '';
  let key;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    key = Buffer.from(raw, 'hex');
  } else if (/^[A-Za-z0-9+/]{43}=?$/.test(raw)) {
    key = Buffer.from(raw, 'base64');
  } else if (raw.length >= 32) {
    key = crypto.createHash('sha256').update(raw, 'utf8').digest();
  } else {
    throw new Error(
      'M365_TOKEN_ENC_KEY missing or too short. Set a 32-byte key in Railway ' +
      'env (64 hex chars, base64, or a 32+ char passphrase) before connecting Outlook.'
    );
  }
  if (key.length !== 32) {
    throw new Error('M365_TOKEN_ENC_KEY must resolve to exactly 32 bytes for AES-256-GCM.');
  }
  _key = key;
  return _key;
}

// Encrypt a UTF-8 string -> versioned ciphertext string. null/undefined pass
// through as null (so an absent token column stays null, not "encrypted empty").
function encrypt(plaintext) {
  if (plaintext == null) return null;
  const key = getKey();
  const iv = crypto.randomBytes(12); // 96-bit nonce, fresh per call
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return 'v1:' + iv.toString('base64') + ':' + tag.toString('base64') + ':' + ct.toString('base64');
}

// Decrypt a versioned ciphertext string -> UTF-8 plaintext. Throws on a
// tampered/corrupt blob (auth-tag mismatch) or a wrong key — fail closed.
function decrypt(blob) {
  if (blob == null) return null;
  const parts = String(blob).split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('secretbox: unrecognized ciphertext format');
  }
  const key = getKey();
  const iv = Buffer.from(parts[1], 'base64');
  const tag = Buffer.from(parts[2], 'base64');
  const ct = Buffer.from(parts[3], 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

// True if a valid key is configured (no throw) — for startup/admin health
// checks and the Connect-Outlook gate.
function isConfigured() {
  try { getKey(); return true; } catch (_) { return false; }
}

module.exports = { encrypt, decrypt, isConfigured };
