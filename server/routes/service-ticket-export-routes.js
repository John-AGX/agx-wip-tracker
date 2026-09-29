// EXPORT A WORK ORDER'S PHOTOS AND FILES AS A ZIP (office only).
//
//   GET /api/service-tickets/:id/export.zip[?receipts=1]
//
// John, 2026-09-29: a zip sorted into before / after / issues, "so I can send
// the report and photos to someone".
//
// WHY A PLAIN LINK AND NOT A FETCH. The archive is photographs — hundreds of
// megabytes is ordinary. A fetch + blob URL holds the whole thing in the
// browser's memory before the user sees a file; an <a href> lets the browser
// stream it to disk. That works because auth accepts the httpOnly `token`
// cookie the app already sets on login (server/auth.js), so the link is
// authenticated without putting a token in a URL where it would end up in
// history and in logs.
//
// STREAMED, ONE FILE AT A TIME. Each attachment is read whole (a few MB) to
// get its CRC, written, and dropped. Memory is one photo, not one export.
//
// THE FAILURE MODE THAT MATTERS. Headers go out before the first byte, so a
// storage read that dies halfway cannot become a 500 — the response is
// already 200 and the client is writing a file. There is nothing honest to
// do at that point except DESTROY the connection, which makes the download
// fail visibly rather than leaving a truncated zip that looks complete. So
// everything that can be checked is checked BEFORE the first byte: the
// ticket, the access, the capability, the file count, and that there is
// anything to send at all.
//
// TENANCY. The ticket is loaded with the caller's org, and every attachment
// the collector returns was read under that same organization_id.
'use strict';

const { pool } = require('../db');
const { requireAuth, hasCapability } = require('../auth');
const { callerOrgId } = require('../org-access');
const { storage } = require('../storage');
const exporter = require('../services/service-ticket-export');
const { createZip } = require('../services/zip-writer');
const workOrder = require('../services/service-ticket-workorder');
const tz = require('../timezone');

const TICKET_NOT_FOUND = 'Service ticket not found';
const REQUIRED_DEPS = ['loadOwnedTicket', 'ticketAccessOk'];

// Receipts show what things cost, so asking for them is a money read even
// though the bytes are a photograph. Reading the work order is not enough.
const RECEIPT_CAPABILITY = 'FINANCIALS_VIEW';
const RECEIPT_CAPABILITY_ALT = 'ESTIMATES_EDIT';

function truthy(v) {
  return v === '1' || v === 'true' || v === 1 || v === true;
}

/** Read a stored object whole. Rejects rather than resolving short. */
function readWhole(key) {
  return storage.getStream(key).then(function (got) {
    return new Promise(function (resolve, reject) {
      const chunks = [];
      let n = 0;
      got.stream.on('data', function (c) { chunks.push(c); n += c.length; });
      got.stream.on('error', reject);
      got.stream.on('end', function () {
        // The size came off the same descriptor the bytes did, so a mismatch
        // means the object changed under us — send nothing rather than a
        // truncated photo the recipient cannot tell is truncated.
        if (got.size != null && n !== got.size) {
          reject(new Error('short read: ' + n + ' of ' + got.size));
          return;
        }
        resolve(Buffer.concat(chunks, n));
      });
    });
  });
}

function registerExportRoutes(router, deps) {
  REQUIRED_DEPS.forEach(function (k) {
    if (typeof deps[k] !== 'function') throw new Error('export routes need ' + k);
  });
  const { loadOwnedTicket, ticketAccessOk } = deps;

  router.get('/:id/export.zip', requireAuth, async function exportZip(req, res) {
    let started = false;
    try {
      const orgId = callerOrgId(req);
      const ticket = await loadOwnedTicket(req.params.id, orgId);
      if (!ticket) return res.status(404).json({ error: TICKET_NOT_FOUND });
      if (!(await ticketAccessOk(req, res, ticket, 'read', orgId))) return;

      const wantReceipts = truthy((req.query || {}).receipts);
      if (wantReceipts &&
          !hasCapability(req.user, RECEIPT_CAPABILITY) &&
          !hasCapability(req.user, RECEIPT_CAPABILITY_ALT)) {
        return res.status(403).json({ error: 'Receipts show what things cost. You cannot export those.' });
      }

      const result = await exporter.collect(pool, ticket, { receipts: wantReceipts });
      if (result.files.length > exporter.MAX_FILES) {
        return res.status(413).json({ error: exporter.MSG.tooMany, files: result.files.length, cap: exporter.MAX_FILES });
      }
      if (!result.files.length) {
        return res.status(409).json({ error: exporter.MSG.nothing });
      }

      const site = await workOrder.workOrderSite(pool, ticket).catch(function () { return null; });
      const zone = await orgZone(orgId);
      const filename = exporter.archiveName(ticket);

      // ── from here the response is committed ──────────────────────────
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'private, no-store');
      // A quoted ASCII name for every client, plus RFC 5987 for the real one.
      res.setHeader('Content-Disposition',
        'attachment; filename="' + filename.replace(/[^\w.\- ]+/g, '_') + '"; ' +
        "filename*=UTF-8''" + encodeURIComponent(filename));
      started = true;

      const zip = createZip(res);
      zip.add('Work order summary.txt', exporter.manifestText(ticket, result, {
        siteLine: site && site.address ? 'Site: ' + site.address : null,
        exportedAt: tz.localDateInTz(zone),
        exportedBy: (req.user && req.user.name) || null,
      }));

      for (const f of result.files) {
        let bytes;
        try {
          bytes = await readWhole(f.key);
        } catch (e) {
          // One unreadable object must not lose the other four hundred. It is
          // recorded in the archive so the gap is VISIBLE — a silently missing
          // photo is the thing somebody discovers a week later.
          console.warn('[service-ticket-export] could not read', f.key, e && e.message);
          zip.add(f.name + '.MISSING.txt',
            'This file could not be read from storage when the export was made.\r\n' +
            'Filename: ' + f.name + '\r\n');
          continue;
        }
        zip.add(f.name, bytes, { date: f.date });
      }

      zip.end();
      res.end();
    } catch (e) {
      console.error('[service-ticket-export] failed', e);
      if (started || res.headersSent) {
        // Already streaming: there is no status left to send. Killing the
        // socket makes the download fail rather than land as a short zip
        // that opens and is quietly missing the tail.
        try { res.destroy(e); } catch (_) { /* nothing left to do */ }
        return undefined;
      }
      return res.status(500).json({ error: 'Failed to build the export' });
    }
    return undefined;
  });
}

async function orgZone(orgId) {
  try {
    const r = await pool.query('SELECT timezone FROM organizations WHERE id = $1', [orgId]);
    return (r.rows[0] && r.rows[0].timezone) || null;
  } catch (e) {
    return null;
  }
}

module.exports = { registerExportRoutes, readWhole, RECEIPT_CAPABILITY, RECEIPT_CAPABILITY_ALT };
