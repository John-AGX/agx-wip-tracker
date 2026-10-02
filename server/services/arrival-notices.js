'use strict';

/* SOMETHING LANDED ON YOUR JOB, AND NOBODY WAS TOLD.
 *
 * Two notices that answer the same question from different doors: a
 * subcontractor put a document in a folder you opened for them, and somebody
 * logged a cost against a job you run. Both are "a thing arrived and the person
 * responsible for the record should know".
 *
 *   sub_document_uploaded   POST /api/sub-portal/attachments
 *   receipt_logged          POST /api/receipts
 *
 * They share a module because they share the whole of their machinery — the
 * recipient resolution, the actor drop, the burst cap — and a third private copy
 * of recipients() was the alternative. They do NOT share a catalog key: a PM
 * wanting to hear about subcontractor paperwork is not the same person wanting
 * to hear about every receipt.
 *
 * ━━ WHAT WAS CUT FROM THIS SLICE, AND WHY IT IS NOT COMING BACK ━━
 *
 * The slice was specified as "a sub uploads a CERTIFICATE or a document". The
 * certificate half does not exist and cannot be built here:
 *
 *   · all three writers of sub_certificates require JOBS_EDIT_ANY
 *     (routes/sub-routes.js), and the cert PDF's own upload needs
 *     'JOBS_EDIT_ANY JOBS_EDIT_OWN' (services/attachment-entity-access.js)
 *   · the builtin sub role holds exactly SUB_PORTAL_VIEW + SUB_PORTAL_UPLOAD
 *   · and `subs` carries no internal owner column at all — no account manager,
 *     no assignee — so even with a door there would be nobody to tell.
 *
 * A certificate reaches Project 86 because somebody in the office records it.
 * That is a different event with a different actor, and inventing a notice for
 * the one that cannot happen is how a feature ships that nothing ever fires.
 *
 * ━━ RECIPIENTS COME OFF THE PARENT, AND ONLY jobs.owner_id IS GUARANTEED ━━
 *
 * The obvious recipient for an upload is attachment_folder_grants.granted_by —
 * the person who opened the folder. It is the right SECOND id and the wrong
 * only one: the column is nullable, and the path that creates most grants fills
 * it with NULL. services/po-sub-access.js grants a folder automatically when a
 * purchase order goes active and binds `userId || null`; on a Buildertrend
 * sync tick there is no user at all (auto-sync passes null). The upsert then
 * writes `granted_by = EXCLUDED.granted_by` with no COALESCE while coalescing
 * folder_id on the very next line, so even a real id is erasable by a later
 * sync. A notice keyed on it alone would go quiet exactly where the population
 * is largest.
 *
 * So the parent entity answers first, and `jobs.owner_id` — NOT NULL, the
 * column services/money-notices.js already calls the job's PM — is the anchor.
 * Every automatic grant is entity_type 'job', which is the same population.
 * A grant on a client or a sub has no internal owner of any kind: those return
 * nobody rather than guessing at an admin.
 *
 * ━━ FIRE FROM ONE HANDLER. THIS IS NOT THE USUAL SYNC ARGUMENT ━━
 *
 * `attachments` has a dozen INSERT sites and `receipts` is re-pointed in bulk by
 * two of them (routes/job-routes.js on lead→job conversion,
 * services/client-merge.js on a merge) plus the clickr polymorphic reconcile.
 * Hanging either notice off the TABLE would mail the lot.
 *
 * And one trap that is specific to these two: the login-less crew-link photo
 * door ALREADY notifies. service-ticket-field-routes.js logs photo_added and
 * services/work-order-notices.js batches it under ticket_crew_activity. A
 * notice any broader than the single sub-portal handler double-mails the same
 * upload. sub-portal-routes.js carries a TODO to extract a shared persist
 * helper — if that happens, the notice must NOT ride into it.
 *
 * ━━ WORDING: TWO THINGS THESE NOTICES MAY NOT CLAIM ━━
 *
 *   · NOT "a photo". At POST /api/receipts the photo is not there yet: the
 *     client creates the receipt, uploads the image, then PATCHes
 *     attachment_id, and that upload is best-effort with its own failure toast.
 *   · NOT that the amount is correct. Cost Inbox labels it "AI-read ·
 *     unconfirmed" in its own UI — "Nobody has confirmed it" — so the amount is
 *     reported as what the record says, in a row, and no sentence asserts a sum
 *     was spent.
 *
 * Nor may either notice call the actor a colleague: POST /api/receipts carries
 * requireAuth and NO capability check, which a sub-portal token also satisfies.
 * Both messages name the person and claim nothing about who they are.
 */

const delivery = require('./notice-delivery');
const text = require('./notice-text');

const KEYS = Object.freeze({
  subDocument: 'sub_document_uploaded',
  receiptLogged: 'receipt_logged',
});

/* A burst cap keyed on the PERSON, which is the fix for the one next door.
 * services/money-notices.js caps on the literal strings 'estimate' | 'po' |
 * 'bill', so a hundred rows in one org starve every other tenant inside the
 * same process-minute and the log says nothing. Keyed per recipient, a crew
 * photographing a stack of receipts quiets their own PM's mail and nobody
 * else's — and the skip is logged.
 *
 * It is still an in-process Map: empty after every deploy, and per-replica.
 * That is honest for a guard against a burst, which is a seconds-long event,
 * and it is NOT load-bearing for correctness the way the digest's ledger is.
 */
const BURST_CAP = 8;
const BURST_WINDOW_MS = 60000;
const _burst = new Map();

function burstAllowed(who, now) {
  const t = Number(now) || Date.now();
  const key = String(who);
  const seen = (_burst.get(key) || []).filter((x) => t - x < BURST_WINDOW_MS);
  seen.push(t);
  _burst.set(key, seen);
  if (seen.length > BURST_CAP) {
    console.warn('[arrival-notices] burst cap reached for user ' + key + ' — notice dropped');
    return false;
  }
  return true;
}

function positiveInt(v) {
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function money(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '';
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/* Users rows for `ids`, in order, de-duplicated, in this org, active, reachable.
 * `skip` is a LIST: an entity door is attributed to the acted-as user while the
 * request belongs to the real admin, and neither should hear about their own
 * upload. */
async function recipients(db, orgId, ids, skip, key) {
  const drop = new Set((skip || []).map(positiveInt).filter(Boolean));
  const want = [];
  const seen = new Set();
  for (const raw of ids || []) {
    const id = positiveInt(raw);
    if (!id || drop.has(id) || seen.has(id)) continue;
    seen.add(id);
    want.push(id);
  }
  if (!want.length) return [];
  const r = await db.query(
    'SELECT id, name, email, role, notification_prefs FROM users'
    + ' WHERE id = ANY($1::int[]) AND organization_id = $2 AND active = TRUE',
    [want, orgId]
  );
  const byId = new Map(r.rows.map((u) => [Number(u.id), u]));
  return want.map((id) => byId.get(id)).filter(Boolean).filter((u) => delivery.reachable(u, key));
}

async function sendAll(db, orgId, users, key, message, opts) {
  const d = delivery.resolveDeps((opts || {}).deps);
  const senderOrg = await delivery.senderOrgFor(db, orgId);
  let sent = 0;
  for (const u of users) {
    const reached = await delivery.deliver(d, u, key, message, {
      orgId: orgId, senderOrg: senderOrg, replyTo: (opts || {}).replyTo,
    });
    if (reached) sent++;
  }
  return sent;
}

function appLink(path) {
  return text.appUrl() + path;
}

/* The internal person responsible for a parent record, and the words for it.
 * Org-predicated on every arm; a parent that does not resolve returns nothing
 * rather than falling through to somebody. */
async function parentOwner(db, entityType, entityId, orgId) {
  const type = String(entityType || '');
  const id = entityId == null ? '' : String(entityId);
  if (!id || orgId == null) return null;

  if (type === 'job') {
    const r = await db.query(
      'SELECT owner_id, data FROM jobs WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL)',
      [id, orgId]);
    if (!r.rows.length) return null;
    const d = (r.rows[0].data && typeof r.rows[0].data === 'object') ? r.rows[0].data : {};
    return {
      ownerId: r.rows[0].owner_id,
      label: text.oneLine([d.jobNumber, d.title || d.name].filter(Boolean).join(' · '), 160) || ('Job ' + id),
      noun: 'job',
      link: appLink('/jobs/' + encodeURIComponent(id) + '/job-files'),
    };
  }
  if (type === 'lead') {
    const r = await db.query(
      // leads has `title`, NOT NULL, and no `name` column — an earlier draft of
      // this selected both and would have thrown on every lead upload.
      'SELECT salesperson_id, title FROM leads WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL)',
      [id, orgId]);
    if (!r.rows.length) return null;
    return {
      ownerId: r.rows[0].salesperson_id,
      label: text.oneLine(r.rows[0].title, 160) || ('Lead ' + id),
      noun: 'lead',
      link: appLink('/estimates/leads'),
    };
  }
  if (type === 'estimate') {
    const r = await db.query(
      'SELECT owner_id, data FROM estimates WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL)',
      [id, orgId]);
    if (!r.rows.length) return null;
    const d = (r.rows[0].data && typeof r.rows[0].data === 'object') ? r.rows[0].data : {};
    return {
      ownerId: r.rows[0].owner_id,
      label: text.oneLine(d.title, 160) || ('Estimate ' + id),
      noun: 'proposal',
      link: appLink('/estimates'),
    };
  }
  // 'client' and 'sub' are real grant targets with NO internal owner column.
  // They resolve to a label only; whoever opened the folder is the only person
  // this notice can reach, and if that is NULL it reaches nobody.
  if (type === 'client') {
    const r = await db.query(
      'SELECT name FROM clients WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL)',
      [id, orgId]);
    if (!r.rows.length) return null;
    return { ownerId: null, label: text.oneLine(r.rows[0].name, 160) || ('Client ' + id), noun: 'client', link: appLink('/estimates/clients') };
  }
  if (type === 'sub') {
    const r = await db.query(
      'SELECT name FROM subs WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL)',
      [id, orgId]);
    if (!r.rows.length) return null;
    return { ownerId: null, label: text.oneLine(r.rows[0].name, 160) || ('Sub ' + id), noun: 'subcontractor', link: appLink('/estimates/subs') };
  }
  return null;
}

/* ── a subcontractor put a document in a folder ──────────────────────────────
 *
 * opts: { subId, subName, entityType, entityId, folder, filename, actorIds,
 *         deps, now }
 *
 * The ORG comes from the SUB, not from the attachment and not from the caller:
 * the new row's organization_id is derived from the parent and legitimately
 * lands NULL when that fails, and a sub-portal user's own organization_id can
 * be NULL too. The sub record is the one thing in this transaction that
 * reliably names a tenant.
 */
async function notifySubDocumentUploaded(db, opts) {
  try {
    const o = opts || {};
    const subId = o.subId == null ? '' : String(o.subId);
    if (!subId) return { sent: 0, skipped: 'no_sub' };

    const sr = await db.query('SELECT id, name, organization_id FROM subs WHERE id = $1', [subId]);
    if (!sr.rows.length) return { sent: 0, skipped: 'no_sub' };
    const orgId = sr.rows[0].organization_id;
    if (orgId == null) return { sent: 0, skipped: 'no_org' };
    const subName = text.oneLine(o.subName || sr.rows[0].name, 120) || 'A subcontractor';

    const parent = await parentOwner(db, o.entityType, o.entityId, orgId);
    if (!parent) return { sent: 0, skipped: 'no_parent' };

    // Whoever opened the folder, after the record's own owner. Nullable, and
    // NULL across the whole automatic-grant population — see the header.
    let grantedBy = null;
    try {
      const g = await db.query(
        'SELECT granted_by FROM attachment_folder_grants'
        + ' WHERE sub_id = $1 AND entity_type = $2 AND entity_id = $3'
        + ' ORDER BY granted_at DESC LIMIT 1',
        [subId, String(o.entityType || ''), String(o.entityId || '')]);
      if (g.rows.length) grantedBy = g.rows[0].granted_by;
    } catch (_) { /* the owner alone is a complete answer */ }

    const key = KEYS.subDocument;
    const to = await recipients(db, orgId, [parent.ownerId, grantedBy], o.actorIds, key);
    if (!to.length) return { sent: 0, skipped: 'nobody' };
    if (!burstAllowed('sub:' + subId, o.now)) return { sent: 0, skipped: 'burst' };

    // The filename is req.file.originalname — whatever the sub typed on their
    // own machine. It is reported, never interpreted: nothing here says what
    // the document IS.
    const filename = text.oneLine(o.filename, 160) || 'a file';
    const folder = text.oneLine(o.folder, 80);
    const rows = [
      [parent.noun.charAt(0).toUpperCase() + parent.noun.slice(1), parent.label],
      ['File', filename],
      ['Folder', folder],
    ];
    const heading = subName + ' uploaded a document';
    const sentence = subName + ' uploaded ' + filename + ' to the ' + parent.noun + ' ' + parent.label + '.';
    const footer = text.footerSentence(
      'You are getting this because you are responsible for that record, or you opened this folder to them.'
    );

    const message = {
      subject: heading + ' — ' + parent.label,
      html: text.emailShell({
        heading: heading,
        bodyHtml: '<p>' + text.escHtml(sentence) + '</p>' + text.rowsHtml(rows),
        button: { label: 'Open the files', href: parent.link },
        footerHtml: footer.html,
      }),
      text: sentence + '\n\n' + text.rowsText(rows) + '\n\nOpen the files: ' + parent.link
        + '\n\n' + footer.text,
      push: {
        title: '📎 ' + subName,
        body: text.pushBody(parent.label, 'Uploaded', filename),
        url: parent.link,
        tag: key + ':' + String(o.entityId || ''),
      },
    };

    const sent = await sendAll(db, orgId, to, key, message, o);
    return { sent: sent, told: to.length };
  } catch (e) {
    console.warn('[arrival-notices] sub document notice failed:', e && e.message);
    return { sent: 0, skipped: 'error' };
  }
}

/* ── a cost was logged against a job or a lead ───────────────────────────────
 *
 * opts: { receipt, orgId, actorIds, actorName, deps, now }
 *
 * Only a job- or lead-linked receipt has anybody to tell. An unlinked capture —
 * which is the DEFAULT, because the Cost Inbox modal opens with "— select a
 * job —" — has no recipient column anywhere, and a 'category' receipt resolves
 * only to cost_categories.created_by, the admin who once made the "Tools"
 * bucket and is not waiting on this. Both return nobody.
 *
 * Which means the notice this slice can honestly send is "a cost landed on your
 * job", not "somebody should go and finish this". The second one is the more
 * useful notice and it is NOT buildable today: the row that needs chasing is
 * exactly the row with nobody's name on it.
 */
async function notifyReceiptLogged(db, opts) {
  try {
    const o = opts || {};
    const r = o.receipt;
    if (!r || r.id == null) return { sent: 0, skipped: 'error' };
    const orgId = o.orgId;
    if (orgId == null) return { sent: 0, skipped: 'no_org' };

    const type = String(r.entity_type || '');
    if (type !== 'job' && type !== 'lead') return { sent: 0, skipped: 'not_linked' };

    const parent = await parentOwner(db, type, r.entity_id, orgId);
    if (!parent) return { sent: 0, skipped: 'no_parent' };

    const key = KEYS.receiptLogged;
    const to = await recipients(db, orgId, [parent.ownerId], o.actorIds, key);
    if (!to.length) return { sent: 0, skipped: 'nobody' };
    const actorId = (o.actorIds || [])[0];
    if (!burstAllowed('receipt:' + (actorId == null ? 'anon' : actorId), o.now)) {
      return { sent: 0, skipped: 'burst' };
    }

    const actorName = text.oneLine(o.actorName, 80) || 'Somebody';
    const vendor = text.oneLine(r.vendor, 120);
    // Reported as what the record says. The Cost Inbox labels this figure
    // "AI-read · unconfirmed" in its own UI, so no sentence here claims a sum
    // was spent — and nothing mentions a photo, which is not attached yet.
    const rows = [
      [parent.noun.charAt(0).toUpperCase() + parent.noun.slice(1), parent.label],
      ['Vendor', vendor],
      ['Amount on the receipt', money(r.amount)],
      ['Cost code', text.oneLine(r.cost_code, 40)],
    ];
    const heading = 'A cost was logged on ' + parent.label;
    const sentence = actorName + ' logged a cost against the ' + parent.noun + ' ' + parent.label
      + (vendor ? ' from ' + vendor : '') + '.';
    const footer = text.footerSentence(
      'You are getting this because you are responsible for that record.'
    );
    const link = appLink('/cost-inbox');

    const message = {
      subject: heading,
      html: text.emailShell({
        heading: heading,
        bodyHtml: '<p>' + text.escHtml(sentence) + '</p>' + text.rowsHtml(rows)
          + '<p style="font-size:13px;color:#6b7280;">'
          + text.escHtml('The amount is as captured and may not have been checked yet.')
          + '</p>',
        button: { label: 'Open the Cost Inbox', href: link },
        footerHtml: footer.html,
      }),
      text: sentence + '\n\n' + text.rowsText(rows)
        + '\n\nThe amount is as captured and may not have been checked yet.'
        + '\n\nOpen the Cost Inbox: ' + link + '\n\n' + footer.text,
      push: {
        title: '🧾 ' + (vendor || 'Cost logged'),
        body: text.pushBody(parent.label, 'Cost', money(r.amount) || 'logged'),
        url: link,
        tag: key + ':' + String(r.entity_id || ''),
      },
    };

    const sent = await sendAll(db, orgId, to, key, message, o);
    return { sent: sent, told: to.length };
  } catch (e) {
    console.warn('[arrival-notices] receipt notice failed:', e && e.message);
    return { sent: 0, skipped: 'error' };
  }
}

module.exports = {
  KEYS,
  BURST_CAP,
  recipients,
  parentOwner,
  notifySubDocumentUploaded,
  notifyReceiptLogged,
  _resetBurst: function () { _burst.clear(); },
};
