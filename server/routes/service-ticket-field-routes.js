// FIELD CAPTURE (Phase 3) — the time, the work performed and the materials
// used on a work order billed after the work. Registered onto the
// service-ticket share router, like the flag doors, so both sides of the one
// credential live on one router and one mount
// (service-ticket-share-routes.js calls registerFieldCaptureRoutes at its end).
//
//   PUBLIC (no auth — the token IS the credential):
//     POST /api/service-ticket-share/:token/labor            FC1 send time
//     POST /api/service-ticket-share/:token/materials-used   FC2 send a material
//     POST /api/service-ticket-share/:token/materials-used/:lineId/receipt
//                                                            FC8 one receipt photo
//       stShareIpLimiter, stShareWriteLimiter, loadTicketShare, receiptGate,
//       upload.single('file')
//       -> receiptGate runs BEFORE multer, so a refused upload is never
//          buffered: the crew gate, the ticket billing after the work, the line
//          sent through THIS link, still waiting on the office, within 2 hours
//          of being sent, under 3 receipts
//       -> upload_id (multipart field, or X-Upload-Id header / ?upload_id= so
//          the gate can see it): a photo already on the line answers
//          duplicate:true even when the gate would now refuse; a stored row
//          that never made it onto the line is put on it, once
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
//
// AND NO RECEIPT COMES BACK. A receipt is a picture of prices. It goes UP from
// the person who stood at the counter and is never served down any link: the
// crew answer carries a COUNT, the photo is tagged so the site-photo read
// leaves it out, and only the office read returns a url.
'use strict';

const { pool } = require('../db');
const { requireAuth, requireOrgId } = require('../auth');
const { callerOrgId } = require('../org-access');
const { stShareIpLimiter, stShareWriteLimiter } = require('../rate-limit');
const fc = require('../services/service-ticket-field-capture');
const workOrder = require('../services/service-ticket-workorder');
const dedupe = require('../services/upload-dedupe');
const tz = require('../timezone');

const TICKET_NOT_FOUND = 'Service ticket not found';
const REQUIRED_DEPS = ['loadTicketShare', 'crewGate', 'crewActor', 'applyCrewName', 'ticketAccessOk',
  'loadOwnedTicket', 'storeShareImage'];

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

function storageModule() { return require('../storage').storage; }

function registerFieldCaptureRoutes(router, deps) {
  const d = deps || {};
  REQUIRED_DEPS.forEach(function (name) {
    if (typeof d[name] !== 'function') throw new Error('registerFieldCaptureRoutes: missing dependency ' + name);
  });
  if (!d.upload || typeof d.upload.single !== 'function') {
    throw new Error('registerFieldCaptureRoutes: missing dependency upload');
  }
  const { loadTicketShare, crewGate, crewActor, applyCrewName, ticketAccessOk, loadOwnedTicket,
    storeShareImage, upload } = d;

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

  // ── FC8: one receipt photo on a material line ─────────────────────────
  // The same pipeline a flagged problem's photo takes
  // (service-ticket-flag-routes.js F2), with one difference that matters: the
  // stored row is tagged 'receipt', which is what keeps it out of the site
  // photos the crew link and the completion report read.
  function duplicateBody(found) {
    return { ok: true, duplicate: true, receipt: { id: found.id } };
  }

  function findTicketUpload(ticket, uploadId) {
    if (!uploadId) return Promise.resolve(null);
    return dedupe.findUpload(pool, {
      orgId: ticket.organization_id, entityType: 'service_ticket', entityId: ticket.id, uploadId: uploadId,
    });
  }

  // The multipart body is not parsed when the gate runs, so the header or the
  // query parameter is the only copy of the upload id it can read.
  function earlyUploadId(req) {
    const h = req.headers && req.headers['x-upload-id'];
    const q = req.query && req.query.upload_id;
    return dedupe.uploadIdFrom({ upload_id: typeof h === 'string' && h ? h : q });
  }

  // BEFORE multer. A request refused here never has its file read.
  async function receiptGate(req, res, next) {
    try {
      if (!crewGate(req, res)) return;
      if (!fc.fieldCaptureOn(req.ticket)) return res.status(409).json({ error: fc.MSG.notTimeAndMaterials });
      const lineId = String(req.params.lineId || '');
      if (!fc.LINE_ID_RE.test(lineId)) return res.status(404).json({ error: fc.MSG.receiptLineNotFound });
      const row = await fc.loadMaterialForReceipt(pool, req.ticket, req.share.id, lineId);
      const verdict = fc.materialMayTakeReceipt(row);
      const early = earlyUploadId(req);
      if (!verdict.ok) {
        // A receipt that already landed on this line, sent again because its
        // answer was lost, is not refused because the office has since
        // decided the line or the two hours have run out.
        if (row && early) {
          const found = await findTicketUpload(req.ticket, early);
          if (found && fc.lineHasReceipt(row, found.id)) return res.json(duplicateBody(found));
        }
        return res.status(verdict.status).json({ error: verdict.error });
      }
      req.materialLine = row;
      req.receiptUploadId = early;
      next();
    } catch (e) {
      console.error('[service-ticket-field] receipt gate failed', e);
      res.status(500).json({ error: fc.MSG.receiptFailed });
    }
  }

  // Is the photo on the line after all (the append committed and only its
  // answer was lost)? true, false, or null when even this read failed.
  async function receiptLanded(share, ticket, lineId, attachmentId) {
    try {
      const row = await fc.loadMaterialForReceipt(pool, ticket, share.id, lineId);
      return !!row && fc.lineHasReceipt(row, attachmentId);
    } catch (_) {
      return null;
    }
  }

  // Best effort: the attachment row goes, and its stored files only once the
  // row is gone (a row left behind is finished by the retry, and needs them).
  async function removeUnattached(orgId, attachmentId, keys) {
    try {
      await pool.query('DELETE FROM attachments WHERE id = $1 AND organization_id = $2', [attachmentId, orgId]);
    } catch (_) {
      return;
    }
    await dedupe.discardKeys(storageModule(), keys);
  }

  router.post('/service-ticket-share/:token/materials-used/:lineId/receipt',
    stShareIpLimiter, stShareWriteLimiter, loadTicketShare, receiptGate, upload.single('file'),
    async function addReceipt(req, res) {
      try {
        const share = req.share;
        const ticket = req.ticket;
        const line = req.materialLine;
        const orgId = ticket.organization_id;

        const uploadId = dedupe.uploadIdFrom(req.body) || req.receiptUploadId || null;
        const duplicateOf = async function () {
          const found = await findTicketUpload(ticket, uploadId);
          if (!found) return false;
          if (fc.lineHasReceipt(line, found.id)) {
            res.json(duplicateBody(found));
            return true;
          }
          const holder = await fc.receiptHolder(pool, ticket, found.id);
          if (holder !== String(line.id) && (holder || !fc.isReceiptRow(found))) {
            // The upload id belongs to another line's receipt, or to a photo
            // that is not a receipt: never moved onto this line.
            res.status(409).json({ error: fc.MSG.receiptFailed });
            return true;
          }
          const attached = await fc.attachReceipt(pool, ticket, line.id, found.id);
          if (!attached.ok) {
            res.status(attached.status).json({ error: attached.error });
            return true;
          }
          if (attached.added) await receiptAdded(share, ticket, line.id, found.id);
          res.json(duplicateBody(found));
          return true;
        };
        if (await duplicateOf()) return;

        const attId = 'att_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        const img = await storeShareImage(req.file, 'service_ticket/' + ticket.id + '/' + attId);
        if (!img || img.error) {
          return res.status((img && img.status) || 400).json({ error: (img && img.error) || 'No file' });
        }
        const keys = [img.thumbKey, img.webKey, img.originalKey];

        const posR = await pool.query(
          "SELECT COALESCE(MAX(position), -1) AS max_pos FROM attachments WHERE entity_type = 'service_ticket' AND entity_id = $1 AND organization_id = $2",
          [ticket.id, orgId]
        );
        const position = (posR.rows[0] && posR.rows[0].max_pos != null) ? Number(posR.rows[0].max_pos) + 1 : 0;

        let ins;
        try {
          ins = await pool.query(
            // uploaded_by NULL: a logged-out crew member. organization_id from
            // the TICKET row in hand. Tagged 'receipt', which is what keeps it
            // off every crew-facing and client-facing photo list.
            `INSERT INTO attachments (id, entity_type, entity_id, folder, filename, mime_type, size_bytes, width, height, thumb_url, web_url, original_url, thumb_key, web_key, original_key, position, uploaded_by, organization_id, tags, client_upload_id)
             VALUES ($1,'service_ticket',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,$19)
             RETURNING id`,
            [attId, ticket.id, 'general', (req.file && req.file.originalname) || null, img.mime,
             img.buf ? img.buf.length : 0, img.width == null ? null : img.width, img.height == null ? null : img.height,
             img.thumbUrl || null, img.webUrl || null, img.originalUrl || null,
             img.thumbKey || null, img.webKey || null, img.originalKey || null, position, null,
             orgId, JSON.stringify([fc.RECEIPT_TAG]), uploadId]
          );
        } catch (e) {
          if (uploadId && dedupe.isUploadIdConflict(e)) {
            await dedupe.discardKeys(storageModule(), keys);
            if (await duplicateOf()) return;
          }
          throw e;
        }

        let attached;
        try {
          attached = await fc.attachReceipt(pool, ticket, line.id, attId);
        } catch (e) {
          // The row is stored but may not be on the line. If the append did
          // commit, this is a success; if it did not, the row and its files go,
          // so no hidden photo is left behind; if even that cannot be told, the
          // row stays and a retry with its upload id finishes it.
          const landed = await receiptLanded(share, ticket, line.id, attId);
          if (landed !== true) {
            if (landed === false) await removeUnattached(orgId, attId, keys);
            throw e;
          }
          attached = { ok: true, added: true };
        }
        if (!attached.ok) {
          await pool.query('DELETE FROM attachments WHERE id = $1 AND organization_id = $2', [attId, orgId]);
          await dedupe.discardKeys(storageModule(), keys);
          return res.status(attached.status).json({ error: attached.error });
        }
        if (attached.added) await receiptAdded(share, ticket, line.id, attId);

        // The ANSWER carries no url either: the page it is going to is a crew
        // link, and it only needs to know the receipt arrived.
        res.json({ ok: true, receipt: { id: (ins.rows[0] && ins.rows[0].id) || attId } });
      } catch (e) {
        console.error('[service-ticket-field] receipt failed', e);
        res.status(500).json({ error: fc.MSG.receiptFailed });
      }
    });

  async function receiptAdded(share, ticket, lineId, attachmentId) {
    lastUsed(share, ticket);
    await workOrder.insertEvent(pool, ticket, 'photo_added', crewActor(share),
      { line_id: lineId, kind: 'receipt', attachment_id: attachmentId });
  }

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
