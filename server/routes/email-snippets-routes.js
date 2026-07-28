// Premium Email Hub — E3 signatures + quick parts. Mounted at
// /api/email-snippets (see server/index.js). Spec: docs/email-hub-premium.md §3.
//
// One table, two kinds (see the email_snippets comment in db.js):
//   kind='signature'  per-user sign-off. At most one is_default, which the
//                     draft box appends.
//   kind='quickpart'  a canned paragraph. user_id NULL = org-shared.
//
// PERMISSIONS:
//   read      any authed user sees their own snippets + the org-shared ones
//   write     a user owns their personal snippets outright; creating or
//             editing an ORG-SHARED quick part needs the admin gate, since
//             it changes what every colleague sees (same posture as
//             org-shared folders in email-folders-routes).
//
// SCOPING: strict organization_id equality — this table is NOT NULL org
// with no legacy rows, so it needs no "OR-IS-NULL (org tolerance)" clause.

'use strict';

const express = require('express');
const crypto = require('crypto');
const { pool } = require('../db');
const { requireAuth, hasCapability } = require('../auth');
const { callerOrgId } = require('../org-access');

const router = express.Router();

const KINDS = ['signature', 'quickpart'];

function newId() {
  return 'esnp_' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
}

async function isOrgAdmin(req) {
  if (req.user && (req.user.role === 'admin' || req.user.role === 'system_admin')) return true;
  return !!(await hasCapability(req.user, 'USERS_MANAGE ROLES_MANAGE SYSTEM_ADMIN'));
}

function normKind(v) {
  const k = String(v || 'quickpart').toLowerCase();
  return KINDS.indexOf(k) === -1 ? 'quickpart' : k;
}
function normName(v) {
  if (typeof v !== 'string') return null;
  const c = v.replace(/\s+/g, ' ').trim().slice(0, 60);
  return c || null;
}
function normBody(v) {
  return String(v == null ? '' : v).slice(0, 20000);
}

// A snippet the caller may READ: their own, or an org-shared one.
async function getReadable(orgId, userId, id) {
  const r = await pool.query(
    `SELECT * FROM email_snippets
      WHERE id = $1 AND organization_id = $2 AND (user_id = $3 OR user_id IS NULL) LIMIT 1`,
    [String(id), orgId, userId]
  );
  return r.rows[0] || null;
}

// ── GET /api/email-snippets?kind=signature|quickpart ────────────────
// The caller's own snippets plus the org-shared ones, personal first.
router.get('/', requireAuth, async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    if (!orgId) return res.json({ snippets: [] });
    const params = [orgId, req.user.id];
    let where = 'organization_id = $1 AND (user_id = $2 OR user_id IS NULL)';
    if (req.query.kind) {
      params.push(normKind(req.query.kind));
      where += ' AND kind = $' + params.length;
    }
    const r = await pool.query(
      'SELECT id, user_id, kind, name, body_text, is_default, sort, created_at, updated_at' +
      '  FROM email_snippets WHERE ' + where +
      ' ORDER BY (user_id IS NULL), kind, sort, name LIMIT 300',
      params
    );
    res.json({ snippets: r.rows });
  } catch (e) {
    console.error('GET /api/email-snippets error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/email-snippets — create ───────────────────────────────
// Body: { kind, name, body_text, is_default?, shared? }
// shared:true creates an ORG-SHARED quick part (admin only). A signature
// is always personal — an org-wide "signature" is a contradiction.
router.post('/', requireAuth, async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    if (!orgId) return res.status(400).json({ error: 'No organization for caller' });
    const b = req.body || {};
    const kind = normKind(b.kind);
    const name = normName(b.name);
    if (!name) return res.status(400).json({ error: 'name is required' });

    const wantShared = b.shared === true || String(b.shared || '') === '1';
    if (wantShared && kind === 'signature') {
      return res.status(400).json({ error: 'Signatures are personal — they cannot be org-shared' });
    }
    if (wantShared && !(await isOrgAdmin(req))) {
      return res.status(403).json({ error: 'Only an admin can create an org-shared quick part' });
    }
    const ownerId = wantShared ? null : req.user.id;
    const isDefault = !!b.is_default;

    // Only one default per owner per kind — clear the old one first, in a
    // transaction, so the partial unique index can never reject the insert.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (isDefault) {
        await client.query(
          'UPDATE email_snippets SET is_default = FALSE, updated_at = NOW()' +
          ' WHERE organization_id = $1 AND COALESCE(user_id, 0) = $2 AND kind = $3 AND is_default',
          [orgId, ownerId == null ? 0 : ownerId, kind]
        );
      }
      const r = await client.query(
        'INSERT INTO email_snippets (id, organization_id, user_id, kind, name, body_text, is_default, sort, created_by)' +
        ' VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
        [newId(), orgId, ownerId, kind, name, normBody(b.body_text), isDefault,
         Math.max(0, parseInt(b.sort, 10) || 0), req.user.id]
      );
      await client.query('COMMIT');
      res.json({ snippet: r.rows[0] });
    } catch (e) {
      await client.query('ROLLBACK');
      if (e && e.code === '23505') {
        return res.status(409).json({ error: 'You already have a ' + kind + ' with that name' });
      }
      throw e;
    } finally {
      client.release();
    }
  } catch (e) {
    console.error('POST /api/email-snippets error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── PATCH /api/email-snippets/:id ───────────────────────────────────
// Body: any subset of { name, body_text, is_default, sort }.
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    if (!orgId) return res.status(404).json({ error: 'Snippet not found' });
    const prior = await getReadable(orgId, req.user.id, req.params.id);
    if (!prior) return res.status(404).json({ error: 'Snippet not found' });
    // An org-shared snippet belongs to everyone, so editing it is admin-only.
    if (prior.user_id === null && !(await isOrgAdmin(req))) {
      return res.status(403).json({ error: 'Only an admin can change an org-shared quick part' });
    }

    const b = req.body || {};
    const sets = [];
    const params = [];
    if (typeof b.name === 'string') {
      const name = normName(b.name);
      if (!name) return res.status(400).json({ error: 'name cannot be empty' });
      params.push(name); sets.push('name = $' + params.length);
    }
    if (b.body_text !== undefined) { params.push(normBody(b.body_text)); sets.push('body_text = $' + params.length); }
    if (b.sort !== undefined) { params.push(Math.max(0, parseInt(b.sort, 10) || 0)); sets.push('sort = $' + params.length); }
    if (!sets.length && b.is_default === undefined) return res.json({ snippet: prior });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (b.is_default !== undefined) {
        if (b.is_default) {
          await client.query(
            'UPDATE email_snippets SET is_default = FALSE, updated_at = NOW()' +
            ' WHERE organization_id = $1 AND COALESCE(user_id, 0) = $2 AND kind = $3 AND is_default AND id <> $4',
            [orgId, prior.user_id == null ? 0 : prior.user_id, prior.kind, prior.id]
          );
        }
        sets.push('is_default = ' + (b.is_default ? 'TRUE' : 'FALSE'));
      }
      sets.push('updated_at = NOW()');
      params.push(prior.id, orgId);
      const r = await client.query(
        'UPDATE email_snippets SET ' + sets.join(', ') +
        ' WHERE id = $' + (params.length - 1) + ' AND organization_id = $' + params.length + ' RETURNING *',
        params
      );
      await client.query('COMMIT');
      res.json({ snippet: r.rows[0] });
    } catch (e) {
      await client.query('ROLLBACK');
      if (e && e.code === '23505') return res.status(409).json({ error: 'A snippet with that name already exists' });
      throw e;
    } finally {
      client.release();
    }
  } catch (e) {
    console.error('PATCH /api/email-snippets/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── DELETE /api/email-snippets/:id ──────────────────────────────────
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    if (!orgId) return res.status(404).json({ error: 'Snippet not found' });
    const prior = await getReadable(orgId, req.user.id, req.params.id);
    if (!prior) return res.status(404).json({ error: 'Snippet not found' });
    if (prior.user_id === null && !(await isOrgAdmin(req))) {
      return res.status(403).json({ error: 'Only an admin can delete an org-shared quick part' });
    }
    await pool.query('DELETE FROM email_snippets WHERE id = $1 AND organization_id = $2', [prior.id, orgId]);
    res.json({ ok: true, deleted: true });
  } catch (e) {
    console.error('DELETE /api/email-snippets/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
