// Email admin routes — Phase 1 of the notifications feature.
//
// Two endpoints, both admin-only:
//   POST /api/email/test   — send a hardcoded test message to a given
//                             address. Useful for verifying provider
//                             config + DNS during initial setup.
//   GET  /api/email/log    — recent send log (last 100 rows, filterable
//                             by ?status=sent|failed|... and ?tag=...)
//
// Future phases will add per-user notification preferences and
// per-event triggers, but neither needs admin gating — only this
// diagnostic surface does.

const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { sendEmail, isEnabled, isDryRun, getEmailSettings, setEmailSettings } = require('../email');
const { EVENTS } = require('../email-events');

const router = express.Router();

console.log('[email-routes] mounted at /api/email');

// GET /api/email/events — catalog of all event types the app fires,
// merged with the current settings (toggle state + recipient config).
// The admin Email page uses this to render the events table.
router.get('/events',
  requireAuth, requireRole('admin'),
  async (req, res) => {
    try {
      const settings = await getEmailSettings();
      const out = EVENTS.map(e => ({
        ...e,
        enabled: !!(settings.events && settings.events[e.key] && settings.events[e.key].enabled),
        bcc: (settings.events && settings.events[e.key] && settings.events[e.key].bcc) || []
      }));
      res.json({ events: out });
    } catch (e) {
      console.error('GET /api/email/events error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// GET /api/email/settings — global email config (per-event toggles +
// global BCC + digest mode + quiet hours).
router.get('/settings',
  requireAuth, requireRole('admin'),
  async (req, res) => {
    try {
      const settings = await getEmailSettings();
      res.json({ settings: settings, configured: isEnabled(), dryRunMode: isDryRun() });
    } catch (e) {
      console.error('GET /api/email/settings error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// PUT /api/email/settings — replace the email config blob. Validates
// shape lightly (events object + bool/string scalars); the admin UI
// is the only writer so we trust its structure.
router.put('/settings',
  requireAuth, requireRole('admin'),
  async (req, res) => {
    try {
      const b = req.body || {};
      const settings = {
        events: (b.events && typeof b.events === 'object') ? b.events : {},
        globalBcc: typeof b.globalBcc === 'string' ? b.globalBcc : '',
        digestMode: !!b.digestMode,
        quietHours: (b.quietHours && typeof b.quietHours === 'object') ? {
          enabled: !!b.quietHours.enabled,
          start: typeof b.quietHours.start === 'string' ? b.quietHours.start : '21:00',
          end: typeof b.quietHours.end === 'string' ? b.quietHours.end : '07:00'
        } : { enabled: false, start: '21:00', end: '07:00' }
      };
      await setEmailSettings(settings);
      res.json({ ok: true, settings: settings });
    } catch (e) {
      console.error('PUT /api/email/settings error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// POST /api/email/test  body: { to, subject?, html? }
router.post('/test',
  requireAuth, requireRole('admin'),
  async (req, res) => {
    try {
      const to = (req.body && req.body.to) || (req.user && req.user.email);
      if (!to) return res.status(400).json({ error: 'to required' });
      const subject = (req.body && req.body.subject) ||
        'AGX email test — ' + new Date().toLocaleString();
      const html = (req.body && req.body.html) ||
        '<div style="font-family:Arial,sans-serif;color:#1f2937;">' +
          '<h2 style="color:#4f8cff;margin:0 0 12px 0;">AGX notifications are working &#x2713;</h2>' +
          '<p>This is a test email from the AGX WIP Tracker.</p>' +
          '<p style="color:#6b7280;font-size:13px;">' +
            'Sent by: ' + (req.user.name || req.user.email) + '<br/>' +
            'Server time: ' + new Date().toISOString() +
          '</p>' +
        '</div>';
      const text = (req.body && req.body.text) ||
        'AGX notifications are working.\n\nSent by: ' + (req.user.name || req.user.email) +
        '\nServer time: ' + new Date().toISOString();
      const result = await sendEmail({
        to: to,
        subject: subject,
        html: html,
        text: text,
        tag: 'admin_test'
      });
      // Surface the configuration state so the admin can see at a
      // glance whether the env is set up correctly.
      res.json({
        ok: result.ok,
        id: result.id,
        providerId: result.providerId,
        error: result.error,
        dryRun: result.dryRun,
        configured: isEnabled(),
        dryRunMode: isDryRun()
      });
    } catch (e) {
      console.error('POST /api/email/test error:', e);
      res.status(500).json({ error: 'Server error', detail: e.message });
    }
  }
);

// GET /api/email/log
router.get('/log',
  requireAuth, requireRole('admin'),
  async (req, res) => {
    try {
      const params = [];
      const where = [];
      if (req.query.status) {
        params.push(String(req.query.status));
        where.push('status = $' + params.length);
      }
      if (req.query.tag) {
        params.push(String(req.query.tag));
        where.push('tag = $' + params.length);
      }
      if (req.query.to) {
        params.push('%' + String(req.query.to).toLowerCase() + '%');
        where.push('lower(to_address) LIKE $' + params.length);
      }
      const sql =
        'SELECT id, to_address, subject, tag, status, provider_id, error, dry_run, sent_at ' +
        'FROM email_log ' +
        (where.length ? 'WHERE ' + where.join(' AND ') + ' ' : '') +
        'ORDER BY sent_at DESC LIMIT 100';
      const { rows } = await pool.query(sql, params);
      res.json({
        rows: rows,
        configured: isEnabled(),
        dryRunMode: isDryRun()
      });
    } catch (e) {
      console.error('GET /api/email/log error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// ── Template editor endpoints (E1B) ────────────────────────────────
const emailTemplates = require('../email-templates');

// GET /api/email/templates — catalog of every event with override state.
router.get('/templates',
  requireAuth, requireRole('admin'),
  async (req, res) => {
    try {
      const { rows } = await pool.query(
        'SELECT event_key, subject, html_body, updated_at FROM email_template_overrides'
      );
      const overridesByKey = {};
      rows.forEach(r => { overridesByKey[r.event_key] = r; });
      const out = EVENTS.map(e => ({
        key: e.key,
        label: e.label,
        category: e.category,
        wired: e.wired,
        hasOverride: !!overridesByKey[e.key],
        updatedAt: overridesByKey[e.key] ? overridesByKey[e.key].updated_at : null
      }));
      res.json({ templates: out });
    } catch (e) {
      console.error('GET /api/email/templates error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// GET /api/email/templates/:key — single template details: default
// + override (if any) + sample params + a rendered preview using
// the current effective template (override-aware).
router.get('/templates/:key',
  requireAuth, requireRole('admin'),
  async (req, res) => {
    try {
      const eventKey = req.params.key;
      const event = EVENTS.find(e => e.key === eventKey);
      if (!event) return res.status(404).json({ error: 'Unknown event' });

      const overrideRows = await pool.query(
        'SELECT subject, html_body, updated_at FROM email_template_overrides WHERE event_key = $1',
        [eventKey]
      );
      const override = overrideRows.rows.length ? overrideRows.rows[0] : null;

      // Try to render preview — wired events have baked-in defaults;
      // unwired (E2) events don't yet, so guard with a try/catch.
      let preview = null;
      try {
        preview = await emailTemplates.renderSample(eventKey);
      } catch (e) {
        preview = { subject: '(no preview — template not yet implemented)', html: '', text: '' };
      }

      // Default rendering (without override) so the editor can show
      // "this is what the baked-in default looks like" alongside any
      // current override.
      let defaultRender = null;
      try {
        defaultRender = emailTemplates.renderSampleDefault(eventKey);
      } catch (e) {
        defaultRender = null;
      }

      res.json({
        event: event,
        override: override,
        sampleParams: emailTemplates.sampleParams(eventKey),
        preview: preview,
        defaultRender: defaultRender
      });
    } catch (e) {
      console.error('GET /api/email/templates/:key error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// PUT /api/email/templates/:key — save (or replace) an override.
// Body: { subject, html_body }
router.put('/templates/:key',
  requireAuth, requireRole('admin'),
  async (req, res) => {
    try {
      const eventKey = req.params.key;
      if (!EVENTS.find(e => e.key === eventKey)) {
        return res.status(404).json({ error: 'Unknown event' });
      }
      const subject = (req.body && typeof req.body.subject === 'string') ? req.body.subject : '';
      const html_body = (req.body && typeof req.body.html_body === 'string') ? req.body.html_body : '';
      const userId = (req.user && req.user.id) || null;
      await pool.query(
        'INSERT INTO email_template_overrides (event_key, subject, html_body, updated_by) ' +
        'VALUES ($1, $2, $3, $4) ' +
        'ON CONFLICT (event_key) DO UPDATE SET ' +
        '  subject = EXCLUDED.subject, ' +
        '  html_body = EXCLUDED.html_body, ' +
        '  updated_by = EXCLUDED.updated_by, ' +
        '  updated_at = NOW()',
        [eventKey, subject, html_body, userId]
      );
      res.json({ ok: true });
    } catch (e) {
      console.error('PUT /api/email/templates/:key error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// DELETE /api/email/templates/:key — clear override (revert to baked-in default).
router.delete('/templates/:key',
  requireAuth, requireRole('admin'),
  async (req, res) => {
    try {
      const eventKey = req.params.key;
      await pool.query(
        'DELETE FROM email_template_overrides WHERE event_key = $1',
        [eventKey]
      );
      res.json({ ok: true });
    } catch (e) {
      console.error('DELETE /api/email/templates/:key error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// POST /api/email/templates/:key/test — render the template (using
// the currently-effective override-or-default) with sample data and
// fire it to the request body's `to` address. Useful for the editor's
// "Send test" button.
router.post('/templates/:key/test',
  requireAuth, requireRole('admin'),
  async (req, res) => {
    try {
      const eventKey = req.params.key;
      if (!EVENTS.find(e => e.key === eventKey)) {
        return res.status(404).json({ error: 'Unknown event' });
      }
      const to = (req.body && req.body.to) || (req.user && req.user.email);
      if (!to) return res.status(400).json({ error: 'to required' });

      let rendered;
      try {
        rendered = await emailTemplates.renderSample(eventKey);
      } catch (e) {
        return res.status(400).json({ error: 'Cannot render: ' + e.message });
      }

      const result = await sendEmail({
        to: to,
        subject: '[TEST] ' + rendered.subject,
        html: rendered.html,
        text: rendered.text,
        tag: 'admin_test_' + eventKey
      });
      res.json({
        ok: result.ok,
        id: result.id,
        providerId: result.providerId,
        error: result.error,
        dryRun: result.dryRun,
        configured: isEnabled(),
        dryRunMode: isDryRun()
      });
    } catch (e) {
      console.error('POST /api/email/templates/:key/test error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

module.exports = router;
