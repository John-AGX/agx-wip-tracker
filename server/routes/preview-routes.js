'use strict';

/* SEE WHAT THEY SEE.
 *
 * John, 2026-10-03: "can you make me a sub view, client view, crew view, portal
 * so i can see what they see when they log in? buildertrend has this" — and,
 * on how far it should go: "i want this to just be something i can look at to
 * see what they are seeing on their end."
 *
 * So this is a WINDOW, not a session. Nothing here changes who you are, nothing
 * here writes, and nothing here hands you authority you did not already have.
 *
 * ━━ WHY act-as IS NOT THIS ━━
 *
 * The repo already has POST /api/auth/act-as, and it is the opposite feature.
 * It keeps the REAL admin as the JWT principal and adds one claim,
 * acting_as_user_id, which is read at eight CREATE sites to decide who gets
 * CREDITED for a row. No read filter, no access guard and no capability check
 * anywhere consults it. Its own header says so: "god-mode visibility +
 * permissions are fully preserved". Act-as changes who the work is attributed
 * to; it does not change one byte of what you see.
 *
 * It also cannot reach a sub in practice. The Users roster that drives its UI
 * excludes role='sub' rows, and a hand-minted sub disguise would still land on
 * index.html — the portal redirect reads currentUser.role, which under act-as
 * is still the admin's — while every /api/sub-portal/* door 403s, because
 * requireCapability reads the real admin's role, which has no SUB_PORTAL_VIEW.
 *
 * ━━ THE READ IS THE PORTAL'S OWN READ ━━
 *
 * These endpoints serve the same shapes as GET /api/sub-portal/me and
 * /api/sub-portal/attachments, through the same functions in
 * services/sub-portal-view.js. That is the whole value of the feature: a
 * preview that re-implements the read is wrong in one of two directions and
 * both mislead the office — it shows a document the sub has not been given, so
 * nobody chases it; or it hides one they have, so it gets sent twice. A test
 * asserts neither caller keeps a second copy.
 *
 * ━━ WHAT IT IS GATED ON, AND WHY NOT MORE ━━
 *
 * JOBS_VIEW_ALL. The portal shows files hanging off jobs and leads, so anybody
 * who may already see every job may see which of those files a given sub has
 * been handed. This grants nothing new; it only arranges what the caller could
 * already read into the shape the sub receives it in.
 *
 * It is NOT gated on SYSTEM_ADMIN like act-as, because act-as is a session with
 * write authority and this is a read. Holding a read-only window to a higher
 * bar than the live product's own screens would be theatre.
 *
 * ━━ TENANCY ━━
 *
 * Every read is predicated on the CALLER's organisation, never on the sub's own
 * stamp and never on a value from the URL. A sub id is caller-supplied, so a
 * sub in another tenant resolves to nothing and answers 404 — the same answer
 * an id that does not exist gets, so the pair cannot be used to ask whether a
 * sub exists somewhere else.
 */

const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireCapability } = require('../auth');
const subView = require('../services/sub-portal-view');

const router = express.Router();

console.log('[preview-routes] mounted at /api/preview');

// Everything here is a read, for somebody who may already see every job.
const guard = [requireAuth, requireCapability('JOBS_VIEW_ALL')];

/* GET /api/preview/audiences
 *
 * What can be looked at, and — just as usefully — what cannot. The honest
 * catalogue: two of the four things the request named have no login at all, and
 * saying so here is better than offering a "client portal" that does not exist.
 */
router.get('/audiences', guard, async (req, res) => {
  res.json({
    audiences: [
      {
        key: 'sub',
        label: 'Subcontractor portal',
        how: 'login',
        ready: true,
        note: 'A real account, but there is no password to type: a sub gets in '
            + 'through a single-use invite link. This shows their portal exactly '
            + 'as they see it, read only.',
      },
      {
        key: 'crew',
        label: 'Crew link (work order)',
        how: 'token link',
        ready: true,
        note: 'No login. A crew member opens a link with a token in it. This '
            + 'shows that page as the holder sees it, without marking the link '
            + 'opened or telling anybody the crew looked.',
      },
      {
        key: 'client',
        label: 'Client',
        how: 'no login',
        ready: true,
        note: 'A client never logs in to Project 86. They receive links: a '
            + 'report to read, a proposal to sign. There is no client portal, so '
            + 'this shows the document they were actually sent.',
      },
    ],
  });
});

/* GET /api/preview/subs — the subs a preview can be opened for.
 *
 * Only subs with a portal user, because a sub nobody has invited has no portal
 * to look at. Saying which is which is the point: "no portal yet" is the most
 * useful thing this list can tell somebody.
 */
router.get('/subs', guard, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT s.id, s.name, s.trade, s.email,
              u.id AS portal_user_id, u.name AS portal_user_name,
              (SELECT COUNT(*) FROM attachment_folder_grants g WHERE g.sub_id = s.id) AS grant_count
         FROM subs s
         LEFT JOIN users u ON u.sub_id = s.id AND u.active = TRUE
        WHERE (s.organization_id = $1 OR s.organization_id IS NULL)
        ORDER BY s.name ASC
        LIMIT 500`,
      [req.user.organization_id]
    );
    res.json({
      subs: rows.map((r) => ({
        id: r.id,
        name: r.name,
        trade: r.trade,
        email: r.email,
        hasPortal: r.portal_user_id != null,
        folders: Number(r.grant_count) || 0,
      })),
    });
  } catch (e) {
    console.error('GET /api/preview/subs error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

/* GET /api/preview/sub-portal/:subId/me
 * GET /api/preview/sub-portal/:subId/attachments
 *
 * The two calls portal.html makes, answered for a sub the caller names instead
 * of for the caller themselves. Same shapes, same projection, same order.
 */
router.get('/sub-portal/:subId/me', guard, async (req, res) => {
  try {
    const sub = await subView.subIdentity(req.params.subId, req.user.organization_id);
    if (!sub) return res.status(404).json({ error: 'Sub record not found' });
    // The portal's own shape is { user, sub }. `user` is whoever is logged in,
    // which in a preview is nobody — the portal renders a name from it, so it
    // carries the sub's own contact rather than the admin's, and `preview`
    // tells the page to say so out loud.
    const { rows } = await pool.query(
      'SELECT email, name FROM users WHERE sub_id = $1 AND active = TRUE ORDER BY id ASC LIMIT 1',
      [sub.id]
    );
    const portalUser = rows[0] || null;
    res.json({
      preview: true,
      user: portalUser
        ? { email: portalUser.email, name: portalUser.name }
        : { email: sub.email || null, name: sub.name || null },
      hasPortal: !!portalUser,
      sub: sub,
    });
  } catch (e) {
    console.error('GET /api/preview/sub-portal/:subId/me error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/sub-portal/:subId/attachments', guard, async (req, res) => {
  try {
    // The sub must resolve in the caller's tenant FIRST. sharedAttachments is
    // keyed on sub_id alone — correct for the live portal, where the id comes
    // from the JWT and cannot be chosen — so in a preview, where the id comes
    // off the URL, the tenancy question is asked here before it is used.
    const sub = await subView.subIdentity(req.params.subId, req.user.organization_id);
    if (!sub) return res.status(404).json({ error: 'Sub record not found' });
    const attachments = await subView.sharedAttachments(sub.id, req.user.organization_id);
    res.json({ preview: true, attachments: attachments });
  } catch (e) {
    console.error('GET /api/preview/sub-portal/:subId/attachments error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ── CREW: the work-order link ──────────────────────────────────────────
 *
 * Shares, so the viewer can pick WHICH crew member’s link to look through:
 * scope and hide_financials differ per share, so "what the crew sees" is not
 * one answer. A ticket with no share yet still previews, against the
 * defaults a new share would carry, and says so.
 */
router.get('/work-order/:ticketId/shares', guard, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT s.id, s.recipient_name, s.recipient_email, s.scope, s.hide_financials,
              s.expires_at, s.revoked_at, s.opened_at, s.view_count
         FROM service_ticket_shares s
         JOIN service_tickets t ON t.id = s.ticket_id
        WHERE s.ticket_id = $1 AND t.organization_id = $2
        ORDER BY s.id DESC LIMIT 50`,
      [req.params.ticketId, req.user.organization_id]
    );
    res.json({ shares: rows });
  } catch (e) {
    console.error('GET /api/preview/work-order/:id/shares error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

/* GET /api/preview/work-order/:ticketId  [?share=<id>]
 *
 * Runs the crew page’s OWN handler — crewPageBody, exported from
 * routes/service-ticket-share-routes.js — against a ticket this caller may
 * see. req.preview tells that body to record nothing: no opened_at, no
 * view_count, no share_opened event. Previewing a link must never announce
 * that the crew opened it.
 *
 * No token is minted, now or ever. The feature asked for a way to LOOK; a
 * preview that created a working credential to do it would be a worse
 * trade than the problem it solved.
 */
router.get('/work-order/:ticketId', guard, async (req, res) => {
  try {
    const t = await pool.query(
      'SELECT * FROM service_tickets WHERE id = $1 AND organization_id = $2',
      [req.params.ticketId, req.user.organization_id]
    );
    if (!t.rows.length) return res.status(404).json({ error: 'Work order not found' });

    // The share decides what the holder sees — hide_financials above all — so
    // a named share is read back and used as-is. Without one, the defaults a
    // new share would carry, which is the cautious direction: money hidden.
    let share = null;
    if (req.query.share) {
      const r = await pool.query(
        `SELECT s.* FROM service_ticket_shares s
           JOIN service_tickets t2 ON t2.id = s.ticket_id
          WHERE s.id = $1 AND s.ticket_id = $2 AND t2.organization_id = $3`,
        [req.query.share, req.params.ticketId, req.user.organization_id]
      );
      if (!r.rows.length) return res.status(404).json({ error: 'Share not found' });
      share = r.rows[0];
    }
    if (!share) {
      share = {
        id: null, ticket_id: t.rows[0].id, scope: 'view',
        hide_financials: true, opened_at: null, recipient_name: null,
        recipient_email: null, expires_at: null, revoked_at: null,
      };
    }

    req.share = share;
    req.ticket = t.rows[0];
    req.preview = true;   // the ONLY thing this changes is what is recorded
    return require('./service-ticket-share-routes').crewPageBody(req, res);
  } catch (e) {
    console.error('GET /api/preview/work-order/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ── CLIENT: the report they were sent ──────────────────────────────────
 *
 * A client has no login and no portal, so the only honest "client view" is
 * the document they actually received. A report share stores a SNAPSHOT of
 * the document at publish time — report_shares.document — because a report
 * is finished, unlike a checklist. So the preview is that stored snapshot,
 * read back: not a re-render of the report as it stands today, which could
 * differ from the copy in the client’s hands.
 *
 * It follows that a report nobody has shared has nothing to preview. That is
 * not a gap to paper over — the client has not been sent anything.
 */
router.get('/client/report-shares', guard, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, entity_type, entity_id, report_id, recipient_email,
              expires_at, revoked_at, opened_at, view_count, created_at
         FROM report_shares
        WHERE organization_id = $1
        ORDER BY created_at DESC LIMIT 100`,
      [req.user.organization_id]
    );
    res.json({ shares: rows });
  } catch (e) {
    console.error('GET /api/preview/client/report-shares error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/client/report-share/:shareId', guard, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, document, revoked_at, expires_at FROM report_shares WHERE id = $1 AND organization_id = $2',
      [req.params.shareId, req.user.organization_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Share not found' });
    // opened_at and view_count are NOT touched. They are how the office
    // knows the client has read it; an internal look must not forge that.
    res.json({
      preview: true,
      document: rows[0].document,
      revoked: !!rows[0].revoked_at,
      expires_at: rows[0].expires_at,
    });
  } catch (e) {
    console.error('GET /api/preview/client/report-share/:id error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
