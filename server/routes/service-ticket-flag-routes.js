// FLAG A PROBLEM (1.29) — three doors, registered onto the service-ticket
// share router so both sides of the one credential live on one router and one
// mount (service-ticket-share-routes.js calls registerFlagRoutes at its end).
//
//   PUBLIC (no auth — the token IS the credential):
//     POST /api/service-ticket-share/:token/flag                  F1 raise
//       stShareIpLimiter, stShareFlagLimiter, loadTicketShare
//       -> crewGate (respond or propose scope; the ticket not draft, approved,
//          closed or cancelled) -> the body's closed set -> client_ref retry
//          lookup -> the building proved on this ticket -> 20 open at most
//     POST /api/service-ticket-share/:token/flags/:flagId/photo   F2 one photo
//       stShareIpLimiter, stShareWriteLimiter, loadTicketShare, flagPhotoGate,
//       upload.single('file')
//       -> flagPhotoGate runs BEFORE multer, so a refused upload is never
//          buffered: crewGate, the flag raised through THIS link on this
//          ticket, still open, within 2 hours of being raised, under 6 photos
//       -> upload_id (multipart field, or X-Upload-Id header / ?upload_id=
//          so the gate can see it): a photo already on the flag answers
//          duplicate:true even when the gate would now refuse; a stored row
//          that never made it onto the flag is put on it, once
//
//   OWNER (requireAuth + the ticket's inherited WRITE capability):
//     POST /api/service-tickets/:id/flags/:flagId/resolve         F3 resolve
//       Allowed on a closed or cancelled ticket, so an old problem can still
//       be cleared. The note is shown on the crew link.
//
// WHY PHOTOS SIT ON THE TICKET. A flag's photo is a service_ticket attachment
// tagged "flag", listed by the flag row — never a task attachment. Every task
// photo not tagged 'before' counts as completion proof, so a damage photo on
// the building would quietly satisfy "add a completion photo".
//
// TENANCY. organization_id, ticket_id and share_id come from the rows
// loadTicketShare / loadOwnedTicket already selected, never from the body.
// The body is read key by key (CREW_FLAG_FIELDS); nothing loops over it.
//
// The notice to the office is a hand-off (flags.handOffRaised), made only
// after the row is stored and never for a retried Send. The crew page says
// "Sent to the office", never that the office was told.
'use strict';

const { pool } = require('../db');
const { requireAuth, requireOrgId } = require('../auth');
const { stShareIpLimiter, stShareWriteLimiter, stShareFlagLimiter } = require('../rate-limit');
const flags = require('../services/service-ticket-flags');
const workOrder = require('../services/service-ticket-workorder');
const dedupe = require('../services/upload-dedupe');

const TICKET_NOT_FOUND = 'Service ticket not found';

const REQUIRED_DEPS = [
  'loadTicketShare', 'crewGate', 'crewActor', 'applyCrewName',
  'storeShareImage', 'ticketAccessOk', 'loadOwnedTicket',
];

function lastUsed(share, ticket) {
  pool.query(
    'UPDATE service_ticket_shares SET last_used_at = NOW() WHERE id = $1 AND organization_id = $2',
    [share.id, ticket.organization_id]
  ).catch(function () { /* a stat is not worth failing a write over */ });
}

function storageModule() { return require('../storage').storage; }

function registerFlagRoutes(router, deps) {
  const d = deps || {};
  REQUIRED_DEPS.forEach(function (name) {
    if (typeof d[name] !== 'function') throw new Error('registerFlagRoutes: missing dependency ' + name);
  });
  if (!d.upload || typeof d.upload.single !== 'function') {
    throw new Error('registerFlagRoutes: missing dependency upload');
  }
  const { loadTicketShare, crewGate, crewActor, applyCrewName, storeShareImage, upload, ticketAccessOk, loadOwnedTicket } = d;

  // ── F1: raise a flag ──────────────────────────────────────────────────
  router.post('/service-ticket-share/:token/flag',
    stShareIpLimiter, stShareFlagLimiter, loadTicketShare, async function raiseFlag(req, res) {
      try {
        if (!crewGate(req, res)) return;
        const share = req.share;
        const ticket = req.ticket;
        const body = req.body || {};

        const v = flags.validateCrewFlag(body);
        if (!v.ok) return res.status(v.status).json({ error: v.error });

        // A retried Send (the answer to the first one was lost) finds the flag
        // the first one stored: the same answer, no second row, no second
        // event, no second alert.
        const answerDuplicate = async function (row) {
          const task = row.task_id != null ? await workOrder.loadSubtask(pool, ticket, row.task_id) : null;
          const byId = await flags.flagPhotos(pool, ticket, [row]);
          return res.json({
            ok: true,
            duplicate: true,
            flag: flags.publicFlag(row, flags.photosFor(row, byId), task ? [task.id] : []),
          });
        };
        if (v.clientRef) {
          const existing = await flags.findByClientRef(pool, ticket, share.id, v.clientRef);
          if (existing) return answerDuplicate(existing);
        }

        let task = null;
        if (v.taskId != null) {
          task = await workOrder.loadSubtask(pool, ticket, v.taskId);
          if (!task) return res.status(404).json({ error: flags.MSG.buildingNotFound });
        }

        if ((await flags.countOpen(pool, ticket)) >= flags.FLAG_OPEN_CAP) {
          return res.status(429).json({ error: flags.MSG.openCap });
        }

        await applyCrewName(share, body);
        const authorLabel = share.recipient_name || share.recipient_email || null;

        const insertAs = function (flag) {
          return flags.insertCrewFlag(pool, {
            ticket: ticket,
            share: share,
            task: task,
            flag: flag,
            authorLabel: authorLabel,
          });
        };
        let row;
        try {
          row = await insertAs(v);
        } catch (e) {
          if (!(v.clientRef && flags.isClientRefConflict(e))) throw e;
          const winner = await flags.findByClientRef(pool, ticket, share.id, v.clientRef);
          if (winner) return answerDuplicate(winner);
          // The unique index spans every link on the ticket, so another
          // link's flag holds this client_ref. That is not this Send's first
          // arrival: store the problem without a client_ref so it still
          // reaches the office.
          row = await insertAs(Object.assign({}, v, { clientRef: null }));
        }
        if (!row) throw new Error('the flag insert returned no row');

        lastUsed(share, ticket);
        const actor = crewActor(share);
        await flags.logFlagEvent(pool, ticket, 'flag_raised', actor,
          { flag_id: row.id, category: row.category, task_id: row.task_id });

        flags.handOffRaised(pool, {
          ticket: ticket,
          share: share,
          flag: {
            id: row.id,
            category: row.category,
            note: row.note,
            task_id: task ? task.id : null,
            task_title: task ? task.title : null,
            created_at: row.created_at,
          },
          task: task ? { id: task.id, title: task.title } : null,
          actor: actor,
          sharedBy: share.created_by,
          photosExpected: v.photosExpected,
        });

        res.json({ ok: true, flag: flags.publicFlag(row, [], task ? [task.id] : []) });
      } catch (e) {
        console.error('[service-ticket-flags] raise failed', e);
        res.status(500).json({ error: flags.MSG.sendFailed });
      }
    });

  // ── F2: one photo on a flag ───────────────────────────────────────────
  // The found row of a repeated upload, as the page expects it.
  function duplicateBody(found) {
    return { ok: true, duplicate: true, photo: { id: found.id, thumb_url: found.thumb_url || null, web_url: found.web_url || null } };
  }

  function findTicketUpload(ticket, uploadId) {
    if (!uploadId) return Promise.resolve(null);
    return dedupe.findUpload(pool, {
      orgId: ticket.organization_id, entityType: 'service_ticket', entityId: ticket.id, uploadId: uploadId,
    });
  }

  // The upload id from the X-Upload-Id header or the upload_id query
  // parameter. The multipart body is not parsed yet when the gate runs, so
  // this is the only copy the gate can read. Optional: the body's upload_id
  // still works after multer.
  function earlyUploadId(req) {
    const h = req.headers && req.headers['x-upload-id'];
    const q = req.query && req.query.upload_id;
    return dedupe.uploadIdFrom({ upload_id: typeof h === 'string' && h ? h : q });
  }

  async function photoAdded(share, ticket, flagId, attachmentId) {
    lastUsed(share, ticket);
    await workOrder.insertEvent(pool, ticket, 'photo_added', crewActor(share),
      { flag_id: flagId, kind: 'flag', attachment_id: attachmentId });
  }

  // BEFORE multer. A request refused here never has its file read.
  async function flagPhotoGate(req, res, next) {
    try {
      if (!crewGate(req, res)) return;
      const flagId = String(req.params.flagId || '');
      if (!flags.FLAG_ID_RE.test(flagId)) {
        return res.status(404).json({ error: flags.MSG.photoFlagNotFound });
      }
      const row = await flags.loadCrewFlagForPhoto(pool, req.ticket, req.share.id, flagId);
      const verdict = flags.flagMayTakePhoto(row);
      const early = earlyUploadId(req);
      if (!verdict.ok) {
        // A photo that already landed on this flag, sent again because its
        // answer was lost, is not refused because the flag has since filled
        // up, passed its 2 hours or been resolved.
        if (row && early) {
          const found = await findTicketUpload(req.ticket, early);
          if (found && flags.flagHasPhoto(row, found.id)) return res.json(duplicateBody(found));
        }
        return res.status(verdict.status).json({ error: verdict.error });
      }
      req.flag = row;
      req.flagUploadId = early;
      next();
    } catch (e) {
      console.error('[service-ticket-flags] photo gate failed', e);
      res.status(500).json({ error: flags.MSG.photoFailed });
    }
  }

  // After attachPhoto threw: is the photo on the flag after all (the append
  // committed and only its answer was lost)? true, false, or null when even
  // this read failed.
  async function photoLanded(share, ticket, flagId, attachmentId) {
    try {
      const row = await flags.loadCrewFlagForPhoto(pool, ticket, share.id, flagId);
      return !!row && flags.flagHasPhoto(row, attachmentId);
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

  router.post('/service-ticket-share/:token/flags/:flagId/photo',
    stShareIpLimiter, stShareWriteLimiter, loadTicketShare, flagPhotoGate, upload.single('file'),
    async function addFlagPhoto(req, res) {
      try {
        const share = req.share;
        const ticket = req.ticket;
        const flag = req.flag;
        const orgId = ticket.organization_id;

        // The same photo sent again (its answer was lost) is found by its
        // upload id. Finding the row is not enough to answer "already added":
        // the first try may have stored it and then failed before it was put
        // on the flag, or still be on its way. That row is put on the flag
        // here, once, before the answer.
        const uploadId = dedupe.uploadIdFrom(req.body) || req.flagUploadId || null;
        const duplicateOf = async function () {
          const found = await findTicketUpload(ticket, uploadId);
          if (!found) return false;
          if (flags.flagHasPhoto(flag, found.id)) {
            res.json(duplicateBody(found));
            return true;
          }
          const holder = await flags.photoHolder(pool, ticket, found.id);
          if (holder !== String(flag.id) && (holder || !flags.isFlagPhotoRow(found))) {
            // The upload id belongs to another flag's photo, or to a photo
            // that is not a problem photo: never moved onto this flag.
            res.status(409).json({ error: flags.MSG.photoFailed });
            return true;
          }
          const attached = await flags.attachPhoto(pool, ticket, flag.id, found.id);
          if (!attached.ok) {
            res.status(attached.status).json({ error: attached.error });
            return true;
          }
          if (attached.added) await photoAdded(share, ticket, flag.id, found.id);
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
            // the TICKET row in hand. Tagged flag, so it is never a site photo
            // and never completion proof.
            `INSERT INTO attachments (id, entity_type, entity_id, folder, filename, mime_type, size_bytes, width, height, thumb_url, web_url, original_url, thumb_key, web_key, original_key, position, uploaded_by, organization_id, tags, client_upload_id)
             VALUES ($1,'service_ticket',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,$19)
             RETURNING id, thumb_url, web_url`,
            [attId, ticket.id, 'general', (req.file && req.file.originalname) || null, img.mime,
             img.buf ? img.buf.length : 0, img.width == null ? null : img.width, img.height == null ? null : img.height,
             img.thumbUrl || null, img.webUrl || null, img.originalUrl || null,
             img.thumbKey || null, img.webKey || null, img.originalKey || null, position, null,
             orgId, JSON.stringify(['flag']), uploadId]
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
          attached = await flags.attachPhoto(pool, ticket, flag.id, attId);
        } catch (e) {
          // The row is stored but may not be on the flag. If the append did
          // commit, this is a success. If it did not, the row and its files
          // go, so no hidden photo is left behind. If even that cannot be
          // told, the row stays and a retry with its upload id finishes it.
          const landed = await photoLanded(share, ticket, flag.id, attId);
          if (landed !== true) {
            if (landed === false) await removeUnattached(orgId, attId, keys);
            throw e;
          }
          attached = { ok: true, added: true };
        }
        if (!attached.ok) {
          // Lost a race for the last slot, or the office resolved it meanwhile:
          // the attachment row goes, and so do its stored files.
          await pool.query('DELETE FROM attachments WHERE id = $1 AND organization_id = $2', [attId, orgId]);
          await dedupe.discardKeys(storageModule(), keys);
          return res.status(attached.status).json({ error: attached.error });
        }

        // added is false only when a retry of this same upload put the row
        // on the flag first; that retry wrote the event.
        if (attached.added) await photoAdded(share, ticket, flag.id, attId);

        const photo = ins.rows[0] || {};
        res.json({ ok: true, photo: { id: photo.id || attId, thumb_url: photo.thumb_url || null, web_url: photo.web_url || null } });
      } catch (e) {
        console.error('[service-ticket-flags] photo failed', e);
        res.status(500).json({ error: flags.MSG.photoFailed });
      }
    });

  // ── F3: the office resolves a flag ────────────────────────────────────
  router.post('/service-tickets/:id/flags/:flagId/resolve', requireAuth, requireOrgId,
    async function resolveTicketFlag(req, res) {
      try {
        const orgId = req.orgId;
        const ticket = await loadOwnedTicket(req.params.id, orgId);
        if (!ticket) return res.status(404).json({ error: TICKET_NOT_FOUND });
        if (!(await ticketAccessOk(req, res, ticket, 'write', orgId))) return;

        const note = flags.cleanResolution((req.body || {}).note);
        if (!note) return res.status(400).json({ error: flags.MSG.resolveNoteRequired });

        const flagId = String(req.params.flagId || '');
        if (!flags.FLAG_ID_RE.test(flagId)) return res.status(404).json({ error: flags.MSG.resolveNotFound });

        const userId = (req.user && req.user.id) || null;
        const row = await flags.resolveFlag(pool, { ticket: ticket, flagId: flagId, userId: userId, note: note });
        if (!row) return res.status(404).json({ error: flags.MSG.resolveNotFound });

        await flags.logFlagEvent(pool, ticket, 'flag_resolved', { kind: 'user', userId: userId },
          { flag_id: row.id, category: row.category, task_id: row.task_id });

        const flag = await flags.loadOfficeFlag(pool, ticket, row.id);
        res.json({ ok: true, flag: flag });
      } catch (e) {
        console.error('[service-ticket-flags] resolve failed', e);
        res.status(500).json({ error: flags.MSG.resolveFailed });
      }
    });

  return router;
}

module.exports = { registerFlagRoutes };
