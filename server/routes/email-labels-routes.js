// Premium Email Hub — E1 label API. Mounted at /api/email-labels
// (see server/index.js). Spec: docs/email-hub-premium.md §1.
//
// Labels are the MULTI axis: many per message, org-shared, rendered as
// colored chips. Storage follows org_tags conventions (CI-unique name per
// org, use_count for most-used-first ordering, archived_at soft-delete so
// historical assignments stay traceable) — see the table comment in db.js.
//
// PERMISSIONS — deliberately looser than org-tags on create, same on
// destructive edits:
//   create        any authed user in the org. Filing mail is per-user
//                 work; making people wait on an admin to mint "Warranty"
//                 would just push them back to Outlook.
//   rename/color/ the label's creator, or an admin. A rename changes what
//   archive/delete every colleague sees, so a stranger may not do it.
//   assign/unassign any authed user, on their OWN messages only.
//
// SCOPING: every query filters organization_id = the caller's org (strict
// equality — this table is NOT NULL org with no legacy rows, so it needs
// no "OR-IS-NULL (org tolerance)" clause). Message-label writes are
// additionally scoped inbound_emails.user_id = req.user.id, because the
// dropbox is personal and excluded from admin act-as by construction.

'use strict';

const express = require('express');
const { pool } = require('../db');
const { requireAuth, hasCapability } = require('../auth');
const { callerOrgId } = require('../org-access');
const ef = require('../services/email-folders');   // normColor — one color format across folders + labels

const router = express.Router();

async function isOrgAdmin(req) {
  if (req.user && (req.user.role === 'admin' || req.user.role === 'system_admin')) return true;
  return !!(await hasCapability(req.user, 'USERS_MANAGE ROLES_MANAGE SYSTEM_ADMIN'));
}

// Trimmed, capped, case PRESERVED — dedupe happens through the
// case-insensitive expression index (same rule as org_tags' normTagName).
function normLabelName(raw) {
  if (typeof raw !== 'string') return null;
  const c = raw.replace(/\s+/g, ' ').trim().slice(0, 40);
  return c || null;
}

// The caller's own message ids out of a candidate list. This is the
// single gate protecting every message-label write: ids that aren't the
// caller's simply don't come back, so a forged id is a silent no-op
// rather than a cross-mailbox write.
async function ownedMessageIds(userId, ids) {
  const list = (Array.isArray(ids) ? ids : [])
    .filter(function (x) { return typeof x === 'string' && x; })
    .slice(0, 1000);
  if (!list.length) return [];
  const r = await pool.query(
    'SELECT id FROM inbound_emails WHERE user_id = $1 AND id = ANY($2::text[])',
    [userId, list]
  );
  return r.rows.map(function (row) { return row.id; });
}

// The caller's own message ids belonging to a set of THREADS.
//
// The hub is a threaded client — it selects conversations, not messages —
// but labels attach per message, so a thread-shaped caller had no way in.
// Mirrors the {ids, thread_ids} convention move-messages already uses, so
// there is one story for "act on a conversation" rather than two. Same
// user_id gate as ownedMessageIds: a foreign thread resolves to nothing.
async function ownedMessageIdsForThreads(userId, threadIds) {
  const list = (Array.isArray(threadIds) ? threadIds : [])
    .filter(function (x) { return typeof x === 'string' && x; })
    .slice(0, 200);
  if (!list.length) return [];
  const r = await pool.query(
    'SELECT id FROM inbound_emails WHERE user_id = $1 AND thread_id = ANY($2::text[])',
    [userId, list]
  );
  return r.rows.map(function (row) { return row.id; });
}

// Union of the explicit message ids and every message in the given threads.
async function resolveTargets(userId, body) {
  const b = body || {};
  const direct = await ownedMessageIds(userId,
    Array.isArray(b.message_ids) ? b.message_ids : (b.message_id ? [b.message_id] : []));
  const threadIds = Array.isArray(b.thread_ids) ? b.thread_ids : (b.thread_id ? [b.thread_id] : []);
  if (!threadIds.length) return direct;
  const fromThreads = await ownedMessageIdsForThreads(userId, threadIds);
  const seen = {};
  return direct.concat(fromThreads).filter(function (id) {
    if (seen[id]) return false;
    seen[id] = 1;
    return true;
  });
}

// A label id in the caller's org, or null.
async function getLabel(orgId, labelId) {
  const id = Number(labelId);
  if (!Number.isFinite(id)) return null;
  const r = await pool.query(
    'SELECT * FROM email_labels WHERE id = $1 AND organization_id = $2 LIMIT 1',
    [id, orgId]
  );
  return r.rows[0] || null;
}

// ── GET /api/email-labels?q=&include_archived=1 ─────────────────────
router.get('/', requireAuth, async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    if (!orgId) return res.json({ labels: [] });
    const where = ['organization_id = $1'];
    const params = [orgId];
    let pn = 2;
    if (String(req.query.include_archived || '') !== '1') where.push('archived_at IS NULL');
    if (req.query.q) {
      where.push('name ILIKE $' + (pn++));
      params.push('%' + String(req.query.q).trim() + '%');
    }
    const r = await pool.query(
      'SELECT id, name, color, sort, use_count, archived_at, created_by, created_at, updated_at' +
      '  FROM email_labels WHERE ' + where.join(' AND ') +
      ' ORDER BY sort ASC, use_count DESC, name ASC LIMIT 500',
      params
    );
    res.json({ labels: r.rows });
  } catch (e) {
    console.error('GET /api/email-labels error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/email-labels — create (idempotent on name) ────────────
// Body: { name, color?, sort? }. An existing label of the same name
// (case-insensitively) is RETURNED rather than duplicated, so a racing
// double-click yields one chip. Un-archives on re-create.
router.post('/', requireAuth, async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    if (!orgId) return res.status(400).json({ error: 'No organization for caller' });
    const b = req.body || {};
    const name = normLabelName(b.name);
    if (!name) return res.status(400).json({ error: 'name is required' });
    const color = ef.normColor(b.color);
    const sort = (b.sort == null) ? 0 : Math.max(0, parseInt(b.sort, 10) || 0);

    // ON CONFLICT targets the case-fold expression index, so "Urgent"
    // folds into an existing "urgent" instead of spawning a second row.
    const r = await pool.query(
      'INSERT INTO email_labels (organization_id, name, color, sort, created_by)' +
      ' VALUES ($1, $2, $3, $4, $5)' +
      ' ON CONFLICT (organization_id, (LOWER(name)))' +
      ' DO UPDATE SET archived_at = NULL, updated_at = NOW()' +
      ' RETURNING *',
      [orgId, name, color, sort, req.user.id]
    );
    res.json({ label: r.rows[0] });
  } catch (e) {
    console.error('POST /api/email-labels error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── PATCH /api/email-labels/:id ─────────────────────────────────────
// Body: any subset of { name, color, sort, archived }. Creator or admin.
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    if (!orgId) return res.status(404).json({ error: 'Label not found' });
    const prior = await getLabel(orgId, req.params.id);
    if (!prior) return res.status(404).json({ error: 'Label not found' });
    if (prior.created_by !== req.user.id && !(await isOrgAdmin(req))) {
      return res.status(403).json({ error: 'Only the label creator or an admin can change it' });
    }

    const b = req.body || {};
    const sets = [];
    const params = [];
    let pn = 1;
    if (typeof b.name === 'string') {
      const name = normLabelName(b.name);
      if (!name) return res.status(400).json({ error: 'name cannot be empty' });
      if (name.toLowerCase() !== String(prior.name).toLowerCase()) {
        const dup = await pool.query(
          'SELECT id FROM email_labels WHERE organization_id = $1 AND LOWER(name) = LOWER($2) AND id <> $3',
          [orgId, name, prior.id]
        );
        if (dup.rowCount) return res.status(409).json({ error: 'A label with that name already exists' });
      }
      sets.push('name = $' + (pn++)); params.push(name);
    }
    if (b.color !== undefined) { sets.push('color = $' + (pn++)); params.push(ef.normColor(b.color)); }
    if (b.sort !== undefined) { sets.push('sort = $' + (pn++)); params.push(Math.max(0, parseInt(b.sort, 10) || 0)); }
    if (b.archived !== undefined) {
      sets.push(b.archived ? 'archived_at = COALESCE(archived_at, NOW())' : 'archived_at = NULL');
    }
    if (!sets.length) return res.json({ label: prior });

    sets.push('updated_at = NOW()');
    params.push(prior.id, orgId);
    const r = await pool.query(
      'UPDATE email_labels SET ' + sets.join(', ') +
      ' WHERE id = $' + (pn++) + ' AND organization_id = $' + (pn++) + ' RETURNING *',
      params
    );
    res.json({ label: r.rows[0] });
  } catch (e) {
    console.error('PATCH /api/email-labels/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── DELETE /api/email-labels/:id ────────────────────────────────────
// ARCHIVES by default (org_tags' soft-delete: the chip leaves the picker,
// existing assignments stay traceable). ?hard=1 really deletes the row,
// which cascades its email_message_labels chips away. Creator or admin.
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    if (!orgId) return res.status(404).json({ error: 'Label not found' });
    const prior = await getLabel(orgId, req.params.id);
    if (!prior) return res.status(404).json({ error: 'Label not found' });
    if (prior.created_by !== req.user.id && !(await isOrgAdmin(req))) {
      return res.status(403).json({ error: 'Only the label creator or an admin can delete it' });
    }
    if (String(req.query.hard || '') === '1') {
      await pool.query('DELETE FROM email_labels WHERE id = $1 AND organization_id = $2', [prior.id, orgId]);
      return res.json({ ok: true, deleted: true });
    }
    await pool.query(
      'UPDATE email_labels SET archived_at = NOW(), updated_at = NOW() WHERE id = $1 AND organization_id = $2',
      [prior.id, orgId]
    );
    res.json({ ok: true, archived: true });
  } catch (e) {
    console.error('DELETE /api/email-labels/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/email-labels/messages/:messageId — chips on one message ─
router.get('/messages/:messageId', requireAuth, async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    if (!orgId) return res.json({ labels: [] });
    const owned = await ownedMessageIds(req.user.id, [req.params.messageId]);
    if (!owned.length) return res.status(404).json({ error: 'Message not found' });
    const r = await pool.query(
      'SELECT l.id, l.name, l.color, l.sort FROM email_message_labels ml' +
      '  JOIN email_labels l ON l.id = ml.label_id' +
      ' WHERE ml.message_id = $1 AND l.organization_id = $2' +
      ' ORDER BY l.sort ASC, l.name ASC',
      [owned[0], orgId]
    );
    res.json({ labels: r.rows });
  } catch (e) {
    console.error('GET /api/email-labels/messages/:messageId error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/email-labels/assign — add labels to messages ──────────
// Body: { message_ids: [...] | message_id, thread_ids: [...] | thread_id,
//         label_ids: [...] | label_id }. Labelling by thread labels every
// message in the conversation, which is what a threaded client means by
// "label this". Idempotent (ON CONFLICT DO NOTHING). Bumps use_count per
// NEW chip so the picker's most-used-first ordering means something.
router.post('/assign', requireAuth, async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    if (!orgId) return res.status(400).json({ error: 'No organization for caller' });
    const b = req.body || {};
    const messageIds = await resolveTargets(req.user.id, b);
    const labelIds = (Array.isArray(b.label_ids) ? b.label_ids : [b.label_id])
      .map(Number).filter(Number.isFinite).slice(0, 50);
    if (!messageIds.length) return res.status(404).json({ error: 'No messages found' });
    if (!labelIds.length) return res.status(400).json({ error: 'label_ids[] is required' });

    // Only labels in the caller's org — a foreign label id is dropped.
    const valid = await pool.query(
      'SELECT id FROM email_labels WHERE organization_id = $1 AND id = ANY($2::bigint[])',
      [orgId, labelIds]
    );
    const okIds = valid.rows.map(function (r) { return r.id; });
    if (!okIds.length) return res.status(404).json({ error: 'No labels found in your organization' });

    const ins = await pool.query(
      'INSERT INTO email_message_labels (message_id, label_id, created_by)' +
      ' SELECT m, l, $3 FROM UNNEST($1::text[]) m CROSS JOIN UNNEST($2::bigint[]) l' +
      ' ON CONFLICT DO NOTHING',
      [messageIds, okIds, req.user.id]
    );
    if (ins.rowCount) {
      await pool.query(
        'UPDATE email_labels SET use_count = use_count + 1, updated_at = NOW() WHERE id = ANY($1::bigint[])',
        [okIds]
      );
    }
    res.json({ ok: true, assigned: ins.rowCount, messages: messageIds.length, labels: okIds.length });
  } catch (e) {
    console.error('POST /api/email-labels/assign error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/email-labels/unassign — remove labels from messages ───
// Body: same shape as /assign, thread_ids included.
router.post('/unassign', requireAuth, async (req, res) => {
  try {
    const orgId = callerOrgId(req);
    if (!orgId) return res.status(400).json({ error: 'No organization for caller' });
    const b = req.body || {};
    const messageIds = await resolveTargets(req.user.id, b);
    const labelIds = (Array.isArray(b.label_ids) ? b.label_ids : [b.label_id])
      .map(Number).filter(Number.isFinite).slice(0, 50);
    if (!messageIds.length) return res.status(404).json({ error: 'No messages found' });
    if (!labelIds.length) return res.status(400).json({ error: 'label_ids[] is required' });

    const del = await pool.query(
      'DELETE FROM email_message_labels ml USING email_labels l' +
      ' WHERE ml.label_id = l.id AND l.organization_id = $3' +
      '   AND ml.message_id = ANY($1::text[]) AND ml.label_id = ANY($2::bigint[])',
      [messageIds, labelIds, orgId]
    );
    res.json({ ok: true, removed: del.rowCount });
  } catch (e) {
    console.error('POST /api/email-labels/unassign error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
