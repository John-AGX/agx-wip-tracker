// Report share portal — both doors in one file, the way task-share-routes.js
// keeps them, so the owner side and the public side of one credential can be
// read together.
//
//   PM-side (requireAuth + capability):
//     POST   /api/reports/:entityType/:entityId/:reportId/share          mint
//     GET    /api/reports/:entityType/:entityId/:reportId/shares         list
//     POST   /api/reports/:entityType/:entityId/:reportId/shares/:sid/revoke
//
//   PUBLIC (no auth — the token IS the credential):
//     GET    /api/report-share/:token
//
// The public door returns exactly two keys: the frozen document snapshot and a
// four-field description of the share itself. It runs no id-joins, so it has
// no way to reach a row the snapshot did not already contain.
'use strict';

const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireCapability } = require('../auth');
const { sendEmail, isEnabled: emailIsEnabled } = require('../email');
const { reportShareIpLimiter, reportShareViewLimiter, reportShareCommentLimiter } = require('../rate-limit');
const shares = require('../services/report-shares');
const { loadReportDocument } = require('../services/report-document');
const { bakeDocumentMaps } = require('../services/report-map-bake');
const { renderReportPdf } = require('../services/report-pdf');
const { storage } = require('../storage');

const router = express.Router();

// Projects sit on the leads/sales side of the capability model, matching the
// attachments and reports routes.
function writeCapFor(entityType) { return entityType === 'project' ? 'LEADS_EDIT' : null; }
function readCapFor(entityType) { return entityType === 'project' ? 'LEADS_VIEW' : null; }
function entityTypeOk(t) { return t === 'project'; }

function newId(prefix) {
  return prefix + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function baseUrl(req) {
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  const host = (req.headers['x-forwarded-host'] || req.get('host') || '').split(',')[0].trim();
  return proto + '://' + host;
}

// Resolve the parent project and PROVE it belongs to the caller's org. A
// foreign or missing id is the same answer — 404 — so this cannot be used to
// probe which project ids exist in other tenants.
async function loadOwnedProject(entityId, req) {
  const orgId = req.user && req.user.organization_id;
  if (!orgId) return { error: 409, message: 'Caller has no organization' };
  const { rows } = await pool.query(
    'SELECT id, name, address_text, organization_id FROM projects WHERE id = $1 AND organization_id = $2',
    [entityId, orgId]
  );
  if (!rows.length) return { error: 404, message: 'project not found' };
  return { project: rows[0], orgId: orgId };
}

async function orgNameFor(orgId) {
  try {
    const r = await pool.query('SELECT name FROM organizations WHERE id = $1', [orgId]);
    return (r.rows[0] && r.rows[0].name) || 'Project 86';
  } catch (e) { return 'Project 86'; }
}

// ── Mint ────────────────────────────────────────────────────────────────
router.post('/reports/:entityType/:entityId/:reportId/share', requireAuth, async (req, res) => {
  const { entityType, entityId, reportId } = req.params;
  if (!entityTypeOk(entityType)) return res.status(400).json({ error: 'Unsupported entity type' });
  return requireCapability(writeCapFor(entityType))(req, res, async () => {
    try {
      const owned = await loadOwnedProject(entityId, req);
      if (owned.error) return res.status(owned.error).json({ error: owned.message });

      const rR = await pool.query(
        'SELECT * FROM job_reports WHERE id = $1 AND entity_type = $2 AND entity_id = $3',
        [reportId, entityType, entityId]
      );
      if (!rR.rows.length) return res.status(404).json({ error: 'Report not found' });
      const report = rR.rows[0];
      // job_reports stores the sections under `sections`; the snapshot builder
      // reads sections_raw, which is what the editor round-trips.
      report.sections_raw = Array.isArray(report.sections) ? report.sections : [];

      const body = req.body || {};
      const scope = shares.normalizeScope(body.scope);
      // hide_financials defaults TRUE — only an explicit false reveals.
      const hideFinancials = body.hide_financials !== false;
      const days = shares.clampTtlDays(body.days);
      const expires = shares.expiryFrom(days);
      const email = String(body.email || '').trim().slice(0, 200);
      const name = String(body.name || '').trim().slice(0, 120);

      const orgName = await orgNameFor(owned.orgId);
      const document = await loadReportDocument(pool, {
        report: report,
        entityType: entityType,
        entityId: entityId,
        project: owned.project,
        orgName: orgName,
        hideFinancials: hideFinancials
      });

      const id = newId('rshare');
      // Bake each photo-map section into a STORED image before the snapshot is
      // written. The Static Maps URL carries the API key, so it must never
      // reach the snapshot a stranger can read — the server fetches the image
      // and stores it, and the document carries a plain image URL. A map that
      // cannot be baked is simply absent; publishing never fails over one.
      const mapNote = await bakeDocumentMaps(storage, document, id);

      const token = shares.genToken();
      await pool.query(
        `INSERT INTO report_shares
           (id, organization_id, report_id, entity_type, entity_id, token_hash,
            scope, hide_financials, document, recipient_email, recipient_name,
            expires_at, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [id, owned.orgId, reportId, entityType, entityId, shares.hashToken(token),
         scope, hideFinancials, JSON.stringify(document), email || null, name || null,
         expires, req.user.id]
      );

      const link = baseUrl(req) + '/r/' + encodeURIComponent(token);

      // sendEmail directly rather than sendForEvent: sendForEvent gates on a
      // per-event admin notification toggle, and an admin muting notifications
      // must not silently disable share invitations. Same choice both
      // precedents made.
      let sent = { ok: false, skipped: 'no-recipient' };
      if (email && emailIsEnabled()) {
        const greet = name || 'there';
        const title = report.title || 'Project report';
        const html =
          '<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.55;color:#222;max-width:540px;">' +
            '<p>Hi ' + escHtml(greet) + ',</p>' +
            '<p><strong>' + escHtml(orgName) + '</strong> has shared a report with you: <strong>' + escHtml(title) + '</strong>.</p>' +
            '<p>Open it in your browser — no login or password needed:</p>' +
            '<p style="margin:24px 0;"><a href="' + escHtml(link) + '" style="background:#2563eb;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;display:inline-block;">View the report</a></p>' +
            '<p style="font-size:12px;color:#666;">This link is just for this report and expires in ' + days + ' days. If you weren\'t expecting it, you can ignore it.</p>' +
          '</div>';
        const text = 'Hi ' + greet + ',\n\n' + orgName + ' has shared a report with you: ' + title +
          '.\n\nOpen it (no login needed):\n' + link + '\n\nThis link expires in ' + days + ' days.';
        sent = await sendEmail({
          to: email,
          subject: orgName + ' shared a report: ' + title,
          html: html, text: text, tag: 'report_share'
        });
      }

      // The raw token appears here, once, and never again — the row holds only
      // its hash. Always return the link even when email is off, so the owner
      // can copy it manually.
      res.json({
        ok: true,
        share: {
          id: id, scope: scope, hide_financials: hideFinancials,
          recipient_email: email || null, recipient_name: name || null,
          expires_at: expires, state: 'sent'
        },
        link: link,
        email_sent: !!sent.ok,
        // Null when every map baked (or there were none). A string names WHY the
        // shared copy has no map, so the owner learns it here rather than from
        // the client who received a photo grid where a site map belonged.
        map_note: mapNote,
        email_error: sent.error || sent.skipped || null
      });
    } catch (e) {
      console.error('POST report share error:', e);
      res.status(500).json({ error: 'Server error: ' + e.message });
    }
  });
});

// ── List ────────────────────────────────────────────────────────────────
router.get('/reports/:entityType/:entityId/:reportId/shares', requireAuth, async (req, res) => {
  const { entityType, entityId, reportId } = req.params;
  if (!entityTypeOk(entityType)) return res.status(400).json({ error: 'Unsupported entity type' });
  return requireCapability(readCapFor(entityType))(req, res, async () => {
    try {
      const owned = await loadOwnedProject(entityId, req);
      if (owned.error) return res.status(owned.error).json({ error: owned.message });
      // token_hash is NEVER selected. Nor is `document` — it is large and the
      // owner already has the live report.
      const { rows } = await pool.query(
        `SELECT id, scope, hide_financials, recipient_email, recipient_name,
                expires_at, opened_at, revoked_at, last_used_at, view_count, created_at
           FROM report_shares
          WHERE report_id = $1 AND organization_id = $2
          ORDER BY created_at DESC
          LIMIT 50`,
        [reportId, owned.orgId]
      );
      const now = Date.now();
      res.json({
        shares: rows.map(function (r) {
          return Object.assign({}, r, { state: shares.shareLifecycle(r, now) });
        })
      });
    } catch (e) {
      console.error('GET report shares error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  });
});

// ── Revoke ──────────────────────────────────────────────────────────────
// Soft, idempotent, one-way, and org-scoped IN THE WHERE CLAUSE rather than in
// an if. A second revoke is a 404, not a re-stamp, so the audit keeps the
// moment it was actually turned off.
router.post('/reports/:entityType/:entityId/:reportId/shares/:sid/revoke', requireAuth, async (req, res) => {
  const { entityType, entityId, reportId, sid } = req.params;
  if (!entityTypeOk(entityType)) return res.status(400).json({ error: 'Unsupported entity type' });
  return requireCapability(writeCapFor(entityType))(req, res, async () => {
    try {
      const owned = await loadOwnedProject(entityId, req);
      if (owned.error) return res.status(owned.error).json({ error: owned.message });
      const { rows } = await pool.query(
        `UPDATE report_shares SET revoked_at = NOW()
          WHERE id = $1 AND report_id = $2 AND organization_id = $3 AND revoked_at IS NULL
        RETURNING id`,
        [sid, reportId, owned.orgId]
      );
      if (!rows.length) return res.status(404).json({ error: 'Share not found or already off' });
      res.json({ ok: true, id: rows[0].id });
    } catch (e) {
      console.error('POST revoke report share error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  });
});

// ── The public door ─────────────────────────────────────────────────────
// The wording of each failure below IS the guest UI — the page prints these
// strings — so they say what happened in plain language without revealing
// whether a token ever existed.
async function loadReportShare(req, res, next) {
  try {
    const token = String(req.params.token || '');
    // Shape-gated BEFORE the database is touched, so a scanner never costs a query.
    if (!shares.isWellFormedToken(token)) return res.status(404).json({ error: 'Invalid link' });
    const { rows } = await pool.query(
      'SELECT * FROM report_shares WHERE token_hash = $1',
      [shares.hashToken(token)]
    );
    if (!rows.length) return res.status(404).json({ error: 'This link is not valid' });
    const share = rows[0];
    if (share.revoked_at) return res.status(410).json({ error: 'This link has been turned off' });
    if (new Date(share.expires_at).getTime() < Date.now()) {
      return res.status(410).json({ error: 'This link has expired' });
    }
    req.share = share;
    next();
  } catch (e) {
    console.error('loadReportShare error:', e);
    res.status(500).json({ error: 'Server error' });
  }
}

router.get('/report-share/:token',
  reportShareIpLimiter, reportShareViewLimiter, loadReportShare,
  async (req, res) => {
    // Fire-and-forget: a failed stats write must never cost the reader the
    // document they came for.
    pool.query(
      `UPDATE report_shares
          SET opened_at = COALESCE(opened_at, NOW()), last_used_at = NOW(),
              view_count = view_count + 1
        WHERE id = $1`,
      [req.share.id]
    ).catch(function () {});

    // Exactly two keys. The snapshot was whitelisted at publish time, and
    // publicShare is a whitelist too — so a column added to report_shares
    // later cannot leak here by default.
    res.json({
      document: req.share.document,
      share: shares.publicShare(req.share)
    });
  });

// ── Save a PDF into the project ─────────────────────────────────────────
// ON DEMAND, never on publish: Chromium is the most expensive thing this
// server does, and a report is shared far more often than it is filed.
//
// The result is stored as an ordinary project ATTACHMENT, so it turns up in
// Files/Explorer beside everything else and can be emailed or attached to a pay
// application — which is the entire reason to render server-side rather than
// letting the browser print.
router.post('/reports/:entityType/:entityId/:reportId/pdf', requireAuth, async (req, res) => {
  const { entityType, entityId, reportId } = req.params;
  if (!entityTypeOk(entityType)) return res.status(400).json({ error: 'Unsupported entity type' });
  return requireCapability(writeCapFor(entityType))(req, res, async () => {
    try {
      const owned = await loadOwnedProject(entityId, req);
      if (owned.error) return res.status(owned.error).json({ error: owned.message });

      const rR = await pool.query(
        'SELECT * FROM job_reports WHERE id = $1 AND entity_type = $2 AND entity_id = $3',
        [reportId, entityType, entityId]
      );
      if (!rR.rows.length) return res.status(404).json({ error: 'Report not found' });
      const report = rR.rows[0];
      report.sections_raw = Array.isArray(report.sections) ? report.sections : [];

      // The INTERNAL document: financials kept, because this file is being
      // filed into the project rather than sent to a client. Anything meant for
      // a client goes out through a share link, which redacts.
      const orgName = await orgNameFor(owned.orgId);
      const document = await loadReportDocument(pool, {
        report: report, entityType: entityType, entityId: entityId,
        project: owned.project, orgName: orgName, hideFinancials: false
      });

      // Bake the location map first — the PDF prints the baked image, since a
      // live map cannot exist in a PDF. Never fatal.
      const mapNote = await bakeDocumentMaps(storage, document, 'pdf_' + reportId);

      let pdf;
      try {
        pdf = await renderReportPdf(document);
      } catch (e) {
        // A missing or unlaunchable browser is an operational fact the user
        // should see plainly, not a 500 with a stack trace.
        console.error('report pdf render failed:', e && e.message);
        return res.status(503).json({ error: (e && e.message) || 'Could not render the PDF.' });
      }

      const safeTitle = String(report.title || 'Report').replace(/[^\w\s.-]/g, '').trim().slice(0, 80) || 'Report';
      const stamp = new Date().toISOString().slice(0, 10);
      const filename = safeTitle + ' — ' + stamp + '.pdf';
      const attId = newId('att');
      const key = 'project/' + entityId + '/' + attId + '.pdf';
      const url = await storage.put(key, pdf, 'application/pdf');

      await pool.query(
        // NOTE: attachments has no organization_id. Its tenancy comes from the
        // PARENT entity — the project proven to be the caller's above — which is
        // the model services/attachment-org-scope.js documents.
        `INSERT INTO attachments
           (id, entity_type, entity_id, filename, mime_type, size_bytes,
            original_key, original_url, uploaded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [attId, entityType, entityId, filename, 'application/pdf', pdf.length,
         key, url, req.user.id]
      );

      res.json({
        ok: true,
        attachment: { id: attId, filename: filename, url: url, size_bytes: pdf.length },
        map_note: mapNote
      });
    } catch (e) {
      console.error('POST report pdf error:', e);
      res.status(500).json({ error: 'Server error: ' + e.message });
    }
  });
});

// ── Guest comments ──────────────────────────────────────────────────────
// A share with scope 'comment' may APPEND to a thread. It may not edit, delete,
// or touch the report itself. That is the whole capability, and it is checked
// here from the STORED scope re-read through normalizeScope on every request —
// never from the request body, and never by the guest page hiding a box.
router.get('/report-share/:token/comments',
  reportShareIpLimiter, reportShareViewLimiter, loadReportShare,
  async (req, res) => {
    try {
      // Readable by any live share, including a view-only one: seeing what has
      // already been said is part of reading the document, and the thread is
      // scoped to THIS share so one recipient never reads another's remarks.
      const { rows } = await pool.query(
        `SELECT body, author_name, section_id, created_at
           FROM report_share_comments
          WHERE share_id = $1
          ORDER BY created_at ASC
          LIMIT 200`,
        [req.share.id]
      );
      res.json({ comments: rows.map(shares.publicComment) });
    } catch (e) {
      console.error('GET report-share comments error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  });

router.post('/report-share/:token/comments',
  reportShareIpLimiter, reportShareCommentLimiter, loadReportShare,
  async (req, res) => {
    try {
      // THE capability check. Re-derived from the row, so a share minted before
      // this feature existed — or one carrying a value a future build wrote —
      // narrows to view and is refused.
      if (!shares.scopeAllows(req.share.scope, 'comment')) {
        return res.status(403).json({ error: 'This link is view-only.' });
      }
      const c = shares.normalizeComment(req.body || {});
      // An empty comment is a mistake, not a silent success — answering ok
      // would leave the reader believing they had been heard.
      if (!c) return res.status(400).json({ error: 'Write something first.' });

      const id = newId('rcmt');
      await pool.query(
        `INSERT INTO report_share_comments
           (id, organization_id, share_id, report_id, section_id, body, author_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [id, req.share.organization_id, req.share.id, req.share.report_id,
         c.section_id, c.body, c.author_name]
      );
      res.json({ ok: true, comment: shares.publicComment(Object.assign({ created_at: new Date() }, c)) });
    } catch (e) {
      console.error('POST report-share comment error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  });

// Owner side: every guest comment on a report, across all its links, with the
// SHARE it arrived through. The recipient on the invitation is the closest
// thing to an identity a bearer token can offer, so it is shown alongside the
// name the guest typed — which is a claim, not identity.
router.get('/reports/:entityType/:entityId/:reportId/comments', requireAuth, async (req, res) => {
  const { entityType, entityId, reportId } = req.params;
  if (!entityTypeOk(entityType)) return res.status(400).json({ error: 'Unsupported entity type' });
  return requireCapability(readCapFor(entityType))(req, res, async () => {
    try {
      const owned = await loadOwnedProject(entityId, req);
      if (owned.error) return res.status(owned.error).json({ error: owned.message });
      const { rows } = await pool.query(
        `SELECT c.id, c.body, c.author_name, c.section_id, c.created_at,
                s.recipient_email, s.recipient_name, s.id AS share_id
           FROM report_share_comments c
           JOIN report_shares s ON s.id = c.share_id
          WHERE c.report_id = $1 AND c.organization_id = $2
          ORDER BY c.created_at DESC
          LIMIT 200`,
        [reportId, owned.orgId]
      );
      res.json({ comments: rows });
    } catch (e) {
      console.error('GET report comments error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  });
});

module.exports = router;
