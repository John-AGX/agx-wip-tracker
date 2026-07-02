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

// ── Open / click tracking (Wave 7) ───────────────────────────────
// Public endpoints — receive opens (1x1 pixel) and clicks (302
// redirect), record events to email_log_events. Both are best-effort:
// if the logId doesn't exist (manual cleanup, expired email, etc.)
// the endpoint still responds normally so the email visual isn't
// broken. Validation only checks the id shape, not existence.

// 1x1 transparent GIF used for the open pixel.
const OPEN_PIXEL_GIF = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64'
);

function isLogIdShape(s) {
  return typeof s === 'string' && /^[a-z0-9_]{6,60}$/i.test(s);
}

// Record an event row; non-blocking on failure.
async function recordTrackEvent(logId, kind, url, req) {
  try {
    const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim().slice(0, 64);
    const ua = (req.headers['user-agent'] || '').toString().slice(0, 500);
    await pool.query(
      'INSERT INTO email_log_events (log_id, kind, url, ip, user_agent) VALUES ($1, $2, $3, $4, $5)',
      [logId, kind, url ? String(url).slice(0, 2000) : null, ip, ua]
    );
  } catch (e) {
    console.warn('[email-track] event insert failed:', e.message);
  }
}

router.get('/track/open/:logId.gif', async (req, res) => {
  const logId = String(req.params.logId || '').replace(/\.gif$/i, '');
  if (isLogIdShape(logId)) {
    // Fire-and-forget so the gif response isn't delayed by the DB write.
    recordTrackEvent(logId, 'open', null, req);
  }
  res.set('Content-Type', 'image/gif');
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.send(OPEN_PIXEL_GIF);
});

router.get('/track/click/:logId', async (req, res) => {
  const logId = String(req.params.logId || '');
  const target = String(req.query.u || '');
  // Safety: only redirect to http(s) URLs (and our own paths) — never
  // to javascript:, data:, etc. Falls back to the app root if the
  // target is missing or unsafe.
  let safeTarget = '/';
  try {
    const decoded = decodeURIComponent(target);
    if (/^https?:\/\//i.test(decoded)) safeTarget = decoded;
    else if (decoded[0] === '/') safeTarget = decoded;
  } catch (e) { /* invalid encoding; keep fallback */ }
  if (isLogIdShape(logId) && target) {
    recordTrackEvent(logId, 'click', safeTarget, req);
  }
  res.redirect(302, safeTarget);
});

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
        'Project 86 email test — ' + new Date().toLocaleString();
      const html = (req.body && req.body.html) ||
        '<div style="font-family:Arial,sans-serif;color:#1f2937;">' +
          '<h2 style="color:#4f8cff;margin:0 0 12px 0;">Project 86 notifications are working &#x2713;</h2>' +
          '<p>This is a test email from the Project 86 WIP Tracker.</p>' +
          '<p style="color:#6b7280;font-size:13px;">' +
            'Sent by: ' + (req.user.name || req.user.email) + '<br/>' +
            'Server time: ' + new Date().toISOString() +
          '</p>' +
        '</div>';
      const text = (req.body && req.body.text) ||
        'Project 86 notifications are working.\n\nSent by: ' + (req.user.name || req.user.email) +
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

// ── Analytics rollup (Wave 7) ────────────────────────────────────
// GET /api/email/analytics — per-template counts of sent / opens /
// clicks over a window (default 30 days). The window's narrow enough
// for the SQL to stay cheap without indexing on sent_at.
router.get('/analytics',
  requireAuth, requireRole('admin'),
  async (req, res) => {
    try {
      const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));
      // sent counts (one row per email_log row, grouped by tag → event_key)
      const sentR = await pool.query(
        "SELECT tag AS event_key, COUNT(*)::int AS sent " +
        "  FROM email_log " +
        " WHERE sent_at >= NOW() - ($1::int * INTERVAL '1 day') " +
        "   AND status IN ('sent', 'dry-run') " +
        " GROUP BY tag",
        [days]
      );
      // open / click counts (per log_id), then aggregate up via the tag.
      const eventR = await pool.query(
        "SELECT el.tag AS event_key, ev.kind, COUNT(*)::int AS c " +
        "  FROM email_log_events ev " +
        "  JOIN email_log el ON el.id = ev.log_id " +
        " WHERE ev.occurred_at >= NOW() - ($1::int * INTERVAL '1 day') " +
        " GROUP BY el.tag, ev.kind",
        [days]
      );
      const byKey = {};
      sentR.rows.forEach(function(r) {
        byKey[r.event_key || '(untagged)'] = { event_key: r.event_key || '(untagged)', sent: r.sent, opens: 0, clicks: 0 };
      });
      eventR.rows.forEach(function(r) {
        const k = r.event_key || '(untagged)';
        if (!byKey[k]) byKey[k] = { event_key: k, sent: 0, opens: 0, clicks: 0 };
        if (r.kind === 'open')  byKey[k].opens  = r.c;
        if (r.kind === 'click') byKey[k].clicks = r.c;
      });
      const rows = Object.values(byKey).sort(function(a, b) { return b.sent - a.sent; });
      res.json({ window_days: days, rows: rows });
    } catch (e) {
      console.error('GET /api/email/analytics error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// ── Template editor endpoints (E1B) ────────────────────────────────
const emailTemplates = require('../email-templates');

// GET /api/email/templates — catalog of every event with override state
// for the caller's organization. System admins see overrides scoped
// to their primary org (same as org admins) — a single platform admin
// editing for all orgs is a future feature.
router.get('/templates',
  requireAuth, requireRole('admin'),
  async (req, res) => {
    try {
      const orgId = (req.user && req.user.organization_id) || null;
      const params = orgId != null ? [orgId] : [];
      const where = orgId != null ? 'WHERE organization_id = $1' : '';
      const { rows } = await pool.query(
        'SELECT event_key, subject, html_body, updated_at FROM email_template_overrides ' + where,
        params
      );
      const overridesByKey = {};
      rows.forEach(r => { overridesByKey[r.event_key] = r; });
      const out = EVENTS.map(e => ({
        key: e.key,
        label: e.label,
        category: e.category,
        scope: e.scope || 'org',  // default any legacy untagged events to org
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

      // Scope overrides to the caller's org. System admins editing
      // for their primary org see their overrides; org admins see
      // theirs.
      const orgId = (req.user && req.user.organization_id) || null;
      const overrideRows = orgId != null
        ? await pool.query(
            'SELECT subject, html_body, updated_at FROM email_template_overrides WHERE event_key = $1 AND organization_id = $2',
            [eventKey, orgId]
          )
        : await pool.query(
            'SELECT subject, html_body, updated_at FROM email_template_overrides WHERE event_key = $1 ORDER BY updated_at DESC LIMIT 1',
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

      // Source — the SAME {{var}}-placeholder strings the renderer
      // uses for the default. The admin Email Templates editor loads
      // this into the textareas so what they edit is what's rendered.
      const defaultSource = (typeof emailTemplates.getDefaultSource === 'function')
        ? emailTemplates.getDefaultSource(eventKey)
        : null;

      // Enriched sample params — the same params the renderer
      // interpolates against. Sent so the admin editor can do
      // client-side live preview as the admin types, without
      // round-tripping every keystroke through the server.
      const enrichedParams = (typeof emailTemplates.enrichedSampleParams === 'function')
        ? emailTemplates.enrichedSampleParams(eventKey)
        : null;

      res.json({
        event: event,
        override: override,
        sampleParams: emailTemplates.sampleParams(eventKey),
        enrichedSampleParams: enrichedParams,
        preview: preview,
        defaultRender: defaultRender,
        defaultSource: defaultSource
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
      const orgId = (req.user && req.user.organization_id) || null;
      if (orgId == null) return res.status(400).json({ error: 'No organization context for this user.' });
      // Fixed ON CONFLICT — table's PK is (organization_id, event_key)
      // per Phase F migration; the previous (event_key) constraint
      // was removed when the composite PK was added.
      await pool.query(
        'INSERT INTO email_template_overrides (organization_id, event_key, subject, html_body, updated_by) ' +
        'VALUES ($1, $2, $3, $4, $5) ' +
        'ON CONFLICT (organization_id, event_key) DO UPDATE SET ' +
        '  subject = EXCLUDED.subject, ' +
        '  html_body = EXCLUDED.html_body, ' +
        '  updated_by = EXCLUDED.updated_by, ' +
        '  updated_at = NOW()',
        [orgId, eventKey, subject, html_body, userId]
      );
      res.json({ ok: true });
    } catch (e) {
      console.error('PUT /api/email/templates/:key error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// DELETE /api/email/templates/:key — clear override (revert to baked-in default).
// Scoped to the caller's org so deleting your override doesn't blow
// away another tenant's customization.
router.delete('/templates/:key',
  requireAuth, requireRole('admin'),
  async (req, res) => {
    try {
      const eventKey = req.params.key;
      const orgId = (req.user && req.user.organization_id) || null;
      if (orgId != null) {
        await pool.query(
          'DELETE FROM email_template_overrides WHERE event_key = $1 AND organization_id = $2',
          [eventKey, orgId]
        );
      } else {
        await pool.query(
          'DELETE FROM email_template_overrides WHERE event_key = $1',
          [eventKey]
        );
      }
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
        // Swap the sample "acting person" placeholders for the caller's
        // real name so a test invite reads like a real one ("John Thilking
        // just created…" instead of the canned "John Project 86"). Only
        // string-typed actor params (system emails); assignedBy is an
        // object on some org samples, so it keeps its canned value.
        const actor = req.user && req.user.name;
        rendered = await emailTemplates.renderSample(
          eventKey,
          actor ? { invitedBy: actor, resetBy: actor } : undefined
        );
      } catch (e) {
        return res.status(400).json({ error: 'Cannot render: ' + e.message });
      }

      // as_test=false → real send, no "[TEST]" prefix on the subject.
      // Used by the per-event "Send sample" button on the admin Email
      // page so admins can fire a manual invitation / password-reset /
      // demo without the subject line screaming TEST.
      const asTest = req.body && req.body.as_test === false ? false : true;
      const result = await sendEmail({
        to: to,
        subject: (asTest ? '[TEST] ' : '') + rendered.subject,
        html: rendered.html,
        text: rendered.text,
        tag: (asTest ? 'admin_test_' : 'admin_send_') + eventKey
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
