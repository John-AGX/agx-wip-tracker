// FIELD CAPTURE (Phase 3) — the time, the work performed and the materials
// used on a work order billed after the work. Registered onto the
// service-ticket share router, like the flag doors, so both sides of the one
// credential live on one router and one mount
// (service-ticket-share-routes.js calls registerFieldCaptureRoutes at its end).
//
//   PUBLIC (no auth — the token IS the credential):
//     POST /api/service-ticket-share/:token/labor            FC1 send time
//     POST /api/service-ticket-share/:token/materials-used   FC2 send a material
//       stShareIpLimiter, stShareWriteLimiter, loadTicketShare
//       -> crewGate (a respond link; the ticket not draft, approved, closed or
//          cancelled) -> the ticket bills after the work (bill_as
//          time_materials, and nothing else decides it) -> the body's named
//          keys -> client_ref retry lookup -> the building proved on this
//          ticket -> 300 lines at most
//
//   OWNER (requireAuth + the ticket's inherited capability):
//     GET  /api/service-tickets/:id/field-log                         FC3 read (READ)
//     POST /api/service-tickets/:id/labor                             FC4 office enters time (WRITE)
//     POST /api/service-tickets/:id/materials-used                    FC5 office enters a material (WRITE)
//     POST /api/service-tickets/:id/labor/:lineId/decide              FC6 accept / correct / reject (WRITE)
//     POST /api/service-tickets/:id/materials-used/:lineId/decide     FC7 the same, for a material (WRITE)
//
// A LINE IS A CLAIM. A crew line lands `submitted` and never changes the work
// order; the office decides it. An office line is born `accepted`. The claimed
// numbers are never overwritten — see services/service-ticket-field-capture.js.
//
// TENANCY. organization_id, ticket_id and share_id come from the rows
// loadTicketShare / loadOwnedTicket already selected, never from the body,
// which is read key by key.
//
// NO MONEY, NO TOTALS TO THE CREW. The crew answers are publicLine — the line
// this link sent, a status word, and nothing the office changed.
'use strict';

const { pool } = require('../db');
const { requireAuth, requireOrgId } = require('../auth');
const { callerOrgId } = require('../org-access');
const { stShareIpLimiter, stShareWriteLimiter } = require('../rate-limit');
const fc = require('../services/service-ticket-field-capture');
const workOrder = require('../services/service-ticket-workorder');
const tz = require('../timezone');

const TICKET_NOT_FOUND = 'Service ticket not found';
const REQUIRED_DEPS = ['loadTicketShare', 'crewGate', 'crewActor', 'applyCrewName', 'ticketAccessOk', 'loadOwnedTicket'];

// The URL word for each kind of line.
const PATH_OF = Object.freeze({ labor: 'labor', material: 'materials-used' });
// Event kinds. Detail is SHAPE only — the crew's words live on the line.
const SENT_EVENT = Object.freeze({ labor: 'labor_sent', material: 'material_sent' });
const ENTERED_EVENT = Object.freeze({ labor: 'labor_entered', material: 'material_entered' });

async function orgToday(orgId) {
  let zone = null;
  try {
    const r = await pool.query('SELECT timezone FROM organizations WHERE id = $1', [orgId]);
    zone = (r.rows[0] && r.rows[0].timezone) || null;
  } catch (e) { zone = null; }
  return tz.localDateInTz(zone);
}

function lastUsed(share, ticket) {
  pool.query(
    'UPDATE service_ticket_shares SET last_used_at = NOW() WHERE id = $1 AND organization_id = $2',
    [share.id, ticket.organization_id]
  ).catch(function () { /* a stat is not worth failing a write over */ });
}

function validate(kind, body, today) {
  return kind === 'labor' ? fc.validateLabor(body, { today: today }) : fc.validateMaterial(body);
}

function registerFieldCaptureRoutes(router, deps) {
  const d = deps || {};
  REQUIRED_DEPS.forEach(function (name) {
    if (typeof d[name] !== 'function') throw new Error('registerFieldCaptureRoutes: missing dependency ' + name);
  });
  const { loadTicketShare, crewGate, crewActor, applyCrewName, ticketAccessOk, loadOwnedTicket } = d;

  // ── FC1 / FC2: the crew sends a line ──────────────────────────────────
  function crewDoor(kind) {
    return async function sendLine(req, res) {
      try {
        if (!crewGate(req, res)) return;
        const share = req.share;
        const ticket = req.ticket;
        // The card is only on a ticket that bills after the work, and the door
        // agrees with the card: a link on any other ticket cannot add lines by
        // calling it directly.
        if (!fc.fieldCaptureOn(ticket)) return res.status(409).json({ error: fc.MSG.notTimeAndMaterials });
        const body = req.body || {};

        const today = kind === 'labor' ? await orgToday(ticket.organization_id) : null;
        const v = validate(kind, body, today);
        if (!v.ok) return res.status(v.status).json({ error: v.error, field: v.field });

        const liveIds = async function () {
          const t = await pool.query(
            `SELECT id FROM tasks WHERE service_ticket_id = $1 AND organization_id = $2
                AND archived_at IS NULL AND scope = 'org'`,
            [ticket.id, ticket.organization_id]
          );
          return t.rows.map(function (r) { return r.id; });
        };
        // A retried Send (its answer was lost) finds what the first one stored:
        // the same answer, no second row, no second event.
        const answerDuplicate = async function (row) {
          return res.json({ ok: true, duplicate: true, line: fc.publicLine(kind, row, await liveIds()) });
        };
        if (v.clientRef) {
          const existing = await fc.findByClientRef(pool, kind, ticket, share.id, v.clientRef);
          if (existing) return answerDuplicate(existing);
        }

        let task = null;
        if (v.taskId != null) {
          task = await workOrder.loadSubtask(pool, ticket, v.taskId);
          if (!task) return res.status(404).json({ error: fc.MSG.buildingNotFound, field: 'task_id' });
        }

        if ((await fc.countLines(pool, kind, ticket)) >= fc.LINE_CAP) {
          return res.status(429).json({ error: fc.MSG.lineCap });
        }

        await applyCrewName(share, body);
        const authorLabel = share.recipient_name || share.recipient_email || null;
        const insertAs = function (line) {
          return fc.insertLine(pool, kind, {
            ticket: ticket, share: share, task: task, line: line, source: 'crew', authorLabel: authorLabel,
          });
        };
        let row;
        try {
          row = await insertAs(v);
        } catch (e) {
          if (!(v.clientRef && fc.isClientRefConflict(kind, e))) throw e;
          const winner = await fc.findByClientRef(pool, kind, ticket, share.id, v.clientRef);
          if (winner) return answerDuplicate(winner);
          // Another link's line holds this client_ref (the index spans the
          // ticket). Not this Send's first arrival: store it without one.
          row = await insertAs(Object.assign({}, v, { clientRef: null }));
        }
        if (!row) throw new Error('the line insert returned no row');

        lastUsed(share, ticket);
        await workOrder.insertEvent(pool, ticket, SENT_EVENT[kind], crewActor(share),
          { line_id: row.id, task_id: row.task_id == null ? null : row.task_id });

        res.json({ ok: true, line: fc.publicLine(kind, row, task ? [task.id] : []) });
      } catch (e) {
        console.error('[service-ticket-field] crew send failed', kind, e);
        res.status(500).json({ error: fc.MSG.sendFailed });
      }
    };
  }

  fc.KINDS.forEach(function (kind) {
    router.post('/service-ticket-share/:token/' + PATH_OF[kind],
      stShareIpLimiter, stShareWriteLimiter, loadTicketShare, crewDoor(kind));
  });

  // ── FC3: the office reads the field log ───────────────────────────────
  router.get('/service-tickets/:id/field-log', requireAuth, async function readFieldLog(req, res) {
    try {
      const orgId = callerOrgId(req);
      const ticket = await loadOwnedTicket(req.params.id, orgId);
      if (!ticket) return res.status(404).json({ error: TICKET_NOT_FOUND });
      if (!(await ticketAccessOk(req, res, ticket, 'read', orgId))) return;
      const log = await fc.listOfficeLines(pool, ticket);
      res.json(Object.assign({ ok: true, enabled: fc.fieldCaptureOn(ticket) }, log));
    } catch (e) {
      console.error('[service-ticket-field] read failed', e);
      res.status(500).json({ error: 'Failed to load the time and materials' });
    }
  });

  // ── FC4 / FC5: the office enters a line itself ────────────────────────
  // A tech who phones it in, or writes it on paper, is not a dead end. The
  // line is marked as entered in the office and is born accepted.
  function officeEntry(kind) {
    return async function enterLine(req, res) {
      try {
        const orgId = req.orgId;
        const ticket = await loadOwnedTicket(req.params.id, orgId);
        if (!ticket) return res.status(404).json({ error: TICKET_NOT_FOUND });
        if (!(await ticketAccessOk(req, res, ticket, 'write', orgId))) return;
        if (!fc.fieldCaptureOn(ticket)) return res.status(409).json({ error: fc.MSG.notTimeAndMaterials });

        const body = req.body || {};
        const today = kind === 'labor' ? await orgToday(orgId) : null;
        const v = validate(kind, body, today);
        if (!v.ok) return res.status(v.status).json({ error: v.error, field: v.field });

        let task = null;
        if (v.taskId != null) {
          task = await workOrder.loadSubtask(pool, ticket, v.taskId);
          if (!task) return res.status(404).json({ error: fc.MSG.buildingNotFound, field: 'task_id' });
        }
        if ((await fc.countLines(pool, kind, ticket)) >= fc.LINE_CAP) {
          return res.status(429).json({ error: fc.MSG.lineCap });
        }

        const userId = (req.user && req.user.id) || null;
        // Who did the work, when the office names them; otherwise the person
        // typing it. Either way the row also says the office entered it.
        const authorLabel = v.label || (req.user && req.user.name) || null;
        const row = await fc.insertLine(pool, kind, {
          ticket: ticket, task: task, line: v, source: 'office', userId: userId, authorLabel: authorLabel,
        });
        if (!row) throw new Error('the line insert returned no row');
        await workOrder.insertEvent(pool, ticket, ENTERED_EVENT[kind], { kind: 'user', userId: userId },
          { line_id: row.id, task_id: row.task_id == null ? null : row.task_id });

        res.json({ ok: true, line: await fc.loadOfficeLine(pool, kind, ticket, row.id) });
      } catch (e) {
        console.error('[service-ticket-field] office entry failed', kind, e);
        res.status(500).json({ error: 'Failed to save that line' });
      }
    };
  }

  // ── FC6 / FC7: accept, correct or reject ──────────────────────────────
  // Allowed at any status, closed included: a bill is often made up after the
  // work order is closed, and deciding a line changes no status and no scope.
  function decideDoor(kind) {
    return async function decide(req, res) {
      try {
        const orgId = req.orgId;
        const ticket = await loadOwnedTicket(req.params.id, orgId);
        if (!ticket) return res.status(404).json({ error: TICKET_NOT_FOUND });
        if (!(await ticketAccessOk(req, res, ticket, 'write', orgId))) return;

        const lineId = String(req.params.lineId || '');
        const claimed = await fc.loadClaim(pool, kind, ticket, lineId);
        if (!claimed) return res.status(404).json({ error: fc.MSG.lineNotFound });

        const decision = fc.validateDecision(kind, req.body || {}, claimed);
        if (!decision.ok) return res.status(decision.status).json({ error: decision.error, field: decision.field });

        const userId = (req.user && req.user.id) || null;
        const row = await fc.decideLine(pool, kind, { ticket: ticket, lineId: lineId, decision: decision, userId: userId });
        if (!row) return res.status(404).json({ error: fc.MSG.lineNotFound });

        const office = decision.office || {};
        const corrected = Object.keys(office).some(function (k) { return office[k] != null; });
        await workOrder.insertEvent(pool, ticket, 'field_line_decided', { kind: 'user', userId: userId }, {
          line_id: row.id, kind: kind, decision: decision.status, corrected: corrected,
        });

        res.json({ ok: true, line: await fc.loadOfficeLine(pool, kind, ticket, row.id) });
      } catch (e) {
        console.error('[service-ticket-field] decide failed', kind, e);
        res.status(500).json({ error: 'Failed to save that decision' });
      }
    };
  }

  fc.KINDS.forEach(function (kind) {
    router.post('/service-tickets/:id/' + PATH_OF[kind], requireAuth, requireOrgId, officeEntry(kind));
    router.post('/service-tickets/:id/' + PATH_OF[kind] + '/:lineId/decide', requireAuth, requireOrgId, decideDoor(kind));
  });

  return router;
}

module.exports = { registerFieldCaptureRoutes, PATH_OF };
