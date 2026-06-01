// Campaign routes (Wave 9). Org-scoped CRUD + send/cancel.
//
// Auth: all endpoints require admin role. organization_id is taken
// from req.user — admins can only manage campaigns within their own
// org (no cross-org leakage even if they pass a bogus id).
//
// Endpoints:
//   POST   /api/email/campaigns                    create draft
//   GET    /api/email/campaigns                    list (org-scoped)
//   GET    /api/email/campaigns/:id                detail + recipients
//   PUT    /api/email/campaigns/:id                edit draft
//   POST   /api/email/campaigns/:id/resolve        preview recipient count
//   POST   /api/email/campaigns/:id/send           start (now or scheduled)
//   POST   /api/email/campaigns/:id/cancel         cancel pending
//   DELETE /api/email/campaigns/:id                soft-delete (archive)

const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../auth');
const campaigns = require('../email-campaigns');

const router = express.Router();

console.log('[email-campaigns-routes] mounted at /api/email/campaigns');

function orgIdFromReq(req) {
  return req.user && req.user.organization_id;
}

function sanitizeQuery(q) {
  q = q || {};
  const out = { type: 'manual' };
  if (q.type === 'subs' || q.type === 'leads' || q.type === 'clients' || q.type === 'manual') {
    out.type = q.type;
  }
  if (q.filters && typeof q.filters === 'object') {
    out.filters = {};
    if (typeof q.filters.trade === 'string')       out.filters.trade = q.filters.trade.slice(0, 100);
    if (typeof q.filters.status === 'string')      out.filters.status = q.filters.status.slice(0, 100);
    if (typeof q.filters.client_type === 'string') out.filters.client_type = q.filters.client_type.slice(0, 100);
  }
  if (out.type === 'manual') {
    out.manual = Array.isArray(q.manual) ? q.manual.slice(0, 5000) : [];
  }
  return out;
}

// ── Create ──────────────────────────────────────────────────────
router.post('/',
  requireAuth, requireRole('admin'),
  async (req, res) => {
    try {
      const orgId = orgIdFromReq(req);
      if (!orgId) return res.status(400).json({ error: 'organization_id required' });
      const b = req.body || {};
      const name = String(b.name || '').slice(0, 200).trim();
      const subject = String(b.subject || '').slice(0, 500).trim();
      const body = String(b.body || '');
      const event_key = b.event_key ? String(b.event_key).slice(0, 100) : null;
      const recipient_query = sanitizeQuery(b.recipient_query);
      const scheduled_at = b.scheduled_at ? new Date(b.scheduled_at) : null;
      if (!name) return res.status(400).json({ error: 'name required' });
      if (!subject) return res.status(400).json({ error: 'subject required' });
      if (!body) return res.status(400).json({ error: 'body required' });
      const id = campaigns.genCampaignId();
      await pool.query(
        "INSERT INTO email_campaigns " +
        "  (id, organization_id, name, event_key, subject, body, recipient_query, scheduled_at, status, created_by) " +
        "VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, 'draft', $9)",
        [id, orgId, name, event_key, subject, body, JSON.stringify(recipient_query), scheduled_at, req.user.id]
      );
      res.json({ ok: true, id: id });
    } catch (e) {
      console.error('POST /api/email/campaigns error:', e);
      res.status(500).json({ error: 'Server error', detail: e.message });
    }
  }
);

// ── List ────────────────────────────────────────────────────────
router.get('/',
  requireAuth, requireRole('admin'),
  async (req, res) => {
    try {
      const orgId = orgIdFromReq(req);
      if (!orgId) return res.json({ rows: [] });
      const r = await pool.query(
        "SELECT id, name, event_key, subject, recipient_query, status, " +
        "       scheduled_at, sent_at, total_count, sent_count, failed_count, created_at " +
        "  FROM email_campaigns " +
        " WHERE organization_id = $1 AND archived_at IS NULL " +
        " ORDER BY created_at DESC LIMIT 100",
        [orgId]
      );
      res.json({ rows: r.rows });
    } catch (e) {
      console.error('GET /api/email/campaigns error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// ── Detail ──────────────────────────────────────────────────────
router.get('/:id',
  requireAuth, requireRole('admin'),
  async (req, res) => {
    try {
      const orgId = orgIdFromReq(req);
      const id = String(req.params.id);
      const r = await pool.query(
        "SELECT * FROM email_campaigns WHERE id = $1 AND organization_id = $2",
        [id, orgId]
      );
      if (!r.rows.length) return res.status(404).json({ error: 'not found' });
      const recR = await pool.query(
        "SELECT id, email, name, status, sent_at, log_id, error " +
        "  FROM email_campaign_recipients WHERE campaign_id = $1 " +
        " ORDER BY id ASC LIMIT 500",
        [id]
      );
      res.json({ campaign: r.rows[0], recipients: recR.rows });
    } catch (e) {
      console.error('GET /api/email/campaigns/:id error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// ── Edit draft ──────────────────────────────────────────────────
router.put('/:id',
  requireAuth, requireRole('admin'),
  async (req, res) => {
    try {
      const orgId = orgIdFromReq(req);
      const id = String(req.params.id);
      const cur = await pool.query(
        "SELECT status FROM email_campaigns WHERE id = $1 AND organization_id = $2",
        [id, orgId]
      );
      if (!cur.rows.length) return res.status(404).json({ error: 'not found' });
      if (cur.rows[0].status !== 'draft' && cur.rows[0].status !== 'scheduled') {
        return res.status(400).json({ error: 'campaign is not editable (status=' + cur.rows[0].status + ')' });
      }
      const b = req.body || {};
      const fields = [];
      const params = [];
      function add(col, val) { params.push(val); fields.push(col + ' = $' + params.length); }
      if (typeof b.name === 'string')    add('name', b.name.slice(0, 200));
      if (typeof b.subject === 'string') add('subject', b.subject.slice(0, 500));
      if (typeof b.body === 'string')    add('body', b.body);
      if (typeof b.event_key === 'string' || b.event_key === null) add('event_key', b.event_key);
      if (b.recipient_query) add('recipient_query', JSON.stringify(sanitizeQuery(b.recipient_query)));
      if (b.scheduled_at !== undefined) add('scheduled_at', b.scheduled_at ? new Date(b.scheduled_at) : null);
      if (!fields.length) return res.json({ ok: true, noop: true });
      params.push(id, orgId);
      await pool.query(
        "UPDATE email_campaigns SET " + fields.join(', ') +
        " WHERE id = $" + (params.length - 1) +
        "   AND organization_id = $" + params.length,
        params
      );
      res.json({ ok: true });
    } catch (e) {
      console.error('PUT /api/email/campaigns/:id error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// ── Resolve preview ─────────────────────────────────────────────
// Returns the first N recipients + total count so the builder can
// show "Will send to 47 recipients" before commit.
router.post('/:id/resolve',
  requireAuth, requireRole('admin'),
  async (req, res) => {
    try {
      const orgId = orgIdFromReq(req);
      const id = String(req.params.id);
      const r = await pool.query(
        "SELECT recipient_query FROM email_campaigns " +
        " WHERE id = $1 AND organization_id = $2",
        [id, orgId]
      );
      if (!r.rows.length) return res.status(404).json({ error: 'not found' });
      const list = await campaigns.resolveRecipients(orgId, r.rows[0].recipient_query);
      res.json({
        total: list.length,
        sample: list.slice(0, 25).map(function(x) { return { email: x.email, name: x.name }; })
      });
    } catch (e) {
      console.error('POST /api/email/campaigns/:id/resolve error:', e);
      res.status(500).json({ error: 'Server error', detail: e.message });
    }
  }
);

// ── Send (now or schedule) ──────────────────────────────────────
router.post('/:id/send',
  requireAuth, requireRole('admin'),
  async (req, res) => {
    try {
      const orgId = orgIdFromReq(req);
      const id = String(req.params.id);
      const cur = await pool.query(
        "SELECT status, scheduled_at FROM email_campaigns WHERE id = $1 AND organization_id = $2",
        [id, orgId]
      );
      if (!cur.rows.length) return res.status(404).json({ error: 'not found' });
      if (cur.rows[0].status !== 'draft' && cur.rows[0].status !== 'scheduled') {
        return res.status(400).json({ error: 'cannot send a ' + cur.rows[0].status + ' campaign' });
      }
      // If a scheduled_at lives in the future, mark scheduled and let
      // the cron pick it up. Otherwise start now.
      const sched = (req.body && req.body.scheduled_at) ? new Date(req.body.scheduled_at) : cur.rows[0].scheduled_at;
      if (sched && sched.getTime() > Date.now() + 30 * 1000) {
        await pool.query(
          "UPDATE email_campaigns SET status='scheduled', scheduled_at=$1 WHERE id=$2",
          [sched, id]
        );
        return res.json({ ok: true, scheduled: true, scheduled_at: sched });
      }
      const result = await campaigns.startCampaign(id);
      res.json({ ok: true, started: true, total: result.total });
    } catch (e) {
      console.error('POST /api/email/campaigns/:id/send error:', e);
      res.status(500).json({ error: 'Server error', detail: e.message });
    }
  }
);

// ── Cancel ──────────────────────────────────────────────────────
router.post('/:id/cancel',
  requireAuth, requireRole('admin'),
  async (req, res) => {
    try {
      const orgId = orgIdFromReq(req);
      const id = String(req.params.id);
      const r = await pool.query(
        "UPDATE email_campaigns SET status='canceled' " +
        " WHERE id = $1 AND organization_id = $2 AND status IN ('draft','scheduled') " +
        " RETURNING id",
        [id, orgId]
      );
      if (!r.rows.length) return res.status(400).json({ error: 'cannot cancel (already sent or completed?)' });
      // Drop any queued recipient rows so nothing fires later if the
      // status field is hand-edited.
      await pool.query(
        "DELETE FROM email_campaign_recipients WHERE campaign_id = $1 AND status = 'queued'",
        [id]
      );
      res.json({ ok: true });
    } catch (e) {
      console.error('POST /api/email/campaigns/:id/cancel error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// ── Archive (soft delete) ───────────────────────────────────────
router.delete('/:id',
  requireAuth, requireRole('admin'),
  async (req, res) => {
    try {
      const orgId = orgIdFromReq(req);
      const id = String(req.params.id);
      const r = await pool.query(
        "UPDATE email_campaigns SET archived_at = NOW() " +
        " WHERE id = $1 AND organization_id = $2 AND archived_at IS NULL " +
        " RETURNING id",
        [id, orgId]
      );
      if (!r.rows.length) return res.status(404).json({ error: 'not found' });
      res.json({ ok: true });
    } catch (e) {
      console.error('DELETE /api/email/campaigns/:id error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

module.exports = router;
