'use strict';

/* SOMEBODY COMMENTED AND NOBODY WAS TOLD.
 *
 * A comment thread has existed on every job, lead, proposal and photo since
 * messaging shipped, and only a DM ever produced a notice — notifyMessageDM in
 * routes/message-routes.js returned on its second line for any key that was
 * not `dm:`, with "emailing the whole org on every comment is out of scope"
 * written next to it. That reasoning was right about the ORG and wrong about
 * the thread: a comment stream has participants, and telling the people who
 * are in a conversation is not a fan-out.
 *
 * WHO HEARS IT. Two groups, both off rows that already exist:
 *
 *   everyone who has posted in this thread   (messages, newest poster first,
 *                                             capped at PARTICIPANT_CAP)
 *   the photo's uploader                     (attachments.uploaded_by, for an
 *                                             `attachment:` thread only)
 *
 * minus the ACTOR. Two ids are dropped, not one: a comment on an entity thread
 * is attributed to the acted-as user while the request is the real admin's, so
 * the caller passes both and neither gets mailed about their own typing.
 *
 * The uploader is the reason photo comments work at all. 86's
 * add_photo_comment tool and the photo viewer's side panel both write into
 * `attachment:<id>` threads, and the person whose photo it is has usually
 * never posted there — so a participants-only rule would have notified nobody
 * on the first comment of every photo, which is the only comment that matters.
 *
 * They are two groups rather than one list because the footer has to be TRUE
 * for the person reading it: a participant is told they posted here, the
 * uploader is told the photo is theirs. One blended sentence covering both
 * would be a guess about which of the two the reader is.
 *
 * NO JOB PM, NO LEAD SALESPERSON, NO CAPABILITY. Owning the record is not the
 * same as being in the conversation, and a PM who runs forty jobs would get
 * every comment on all of them. Posting once is how you join; that is the
 * whole rule, and it is the rule the inbox already uses to decide which
 * threads are yours (GET /api/messages/recent).
 *
 * THE SYNC CANNOT REACH THIS. Unlike the money notices next door, no caution
 * is needed: services/clickr/* never writes `messages` and has no thread_key
 * anywhere in it, so Buildertrend has no door into a comment thread. The two
 * writers are the human POST and 86's tool, and both are called from their own
 * handler, after the row is committed.
 *
 * BEST-EFFORT. Nothing here throws; callers hand the promise to
 * services/inflight.js so a deploy lets it finish.
 */

const delivery = require('./notice-delivery');
const text = require('./notice-text');
const scope = require('./attachment-org-scope');

const KEY = 'comment_posted';

// Newest posters first, so an old thread that one person has drifted away from
// does not crowd out the people talking in it today.
const PARTICIPANT_CAP = 10;

// A paste storm, or 86 writing a run of comments from one instruction, should
// not become a page of near-identical mail. Counted per THREAD per minute, so
// two people talking in different threads never collide. Same shape as
// BURST_CAP in services/money-notices.js.
const BURST_CAP = 6;
const BURST_WINDOW_MS = 60000;
const _burst = new Map();   // thread key -> [timestamps]

function burstAllowed(key, now) {
  const t = Number(now) || Date.now();
  const seen = (_burst.get(key) || []).filter((x) => t - x < BURST_WINDOW_MS);
  seen.push(t);
  _burst.set(key, seen);
  return seen.length <= BURST_CAP;
}

function positiveInt(v) {
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function appLink(path) {
  return text.appUrl() + path;
}

/* Users rows for `ids`, in the order given, de-duplicated, inside this
 * organization, still active, and still reachable on some channel. `skip` is a
 * LIST — see the actor note in the header; the twin in money-notices.js drops
 * a single actor because a money route has exactly one.
 */
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

/* Who has posted in this thread, newest first.
 *
 * The org term matches the thread read in routes/message-routes.js exactly,
 * `OR organization_id IS NULL` included: rows written before the backfill
 * carry no stamp, and dropping them here would silently shrink the audience of
 * every thread that predates it. The caller has already proved the THREAD
 * belongs to this org (services/thread-org-scope.js), so this term is the
 * second layer, not the gate.
 */
async function participantIds(db, key, orgId) {
  const r = await db.query(
    'SELECT user_id, MAX(created_at) AS last_at FROM messages'
    + ' WHERE thread_key = $1 AND (organization_id = $2 OR organization_id IS NULL)'
    + ' AND user_id IS NOT NULL'
    + ' GROUP BY user_id ORDER BY MAX(created_at) DESC LIMIT $3',
    [key, orgId, PARTICIPANT_CAP]
  );
  return r.rows.map((x) => x.user_id);
}

/* The photo behind an `attachment:` thread: its name for the subject line, its
 * parent for the link, its uploader for the second audience.
 *
 * Read by id and then put through attachmentInOrg rather than predicated in
 * SQL, because attachments.organization_id is NULL on everything written
 * before the backfill and the parent entity is the real anchor — the ladder in
 * services/attachment-org-scope.js is what knows that. A row this org cannot
 * see returns null and the notice falls back to the thread key.
 */
async function photoFacts(db, attId, orgId) {
  const r = await db.query(
    'SELECT id, filename, entity_type, entity_id, organization_id, uploaded_by'
    + ' FROM attachments WHERE id = $1',
    [attId]
  );
  if (!r.rows.length) return null;
  const row = r.rows[0];
  if (!(await scope.attachmentInOrg(db, row, orgId))) return null;
  return row;
}

/* Where the notice sends you. A job comment now has a real destination — the
 * Comments sub-tab this slice built — and a photo comment lands on the Photos
 * tab of the job the photo hangs on. A lead or proposal thread has no
 * per-record deep link in the router at all, so those go to Messages, where
 * the thread is top of the list because it just moved.
 */
function threadLink(parts, photo) {
  if (parts.kind === 'job') {
    return appLink('/jobs/' + encodeURIComponent(parts.id) + '/job-comments');
  }
  if (parts.kind === 'attachment' && photo && photo.entity_type === 'job' && photo.entity_id) {
    return appLink('/jobs/' + encodeURIComponent(photo.entity_id) + '/job-photos');
  }
  return appLink('/messages');
}

function splitKey(key) {
  const s = String(key || '');
  const i = s.indexOf(':');
  if (i <= 0) return null;
  return { kind: s.slice(0, i), id: s.slice(i + 1) };
}

// What the thread is ABOUT, in the words a person would use for it.
function aboutWords(kind) {
  if (kind === 'job') return 'this job';
  if (kind === 'lead') return 'this lead';
  if (kind === 'estimate') return 'this proposal';
  if (kind === 'attachment') return 'this photo';
  return 'this record';
}

/* The message. `because` is the footer's reason, which is the only thing that
 * differs between the two audiences.
 */
function commentMessage(o) {
  const label = o.label;
  const quote = text.oneLine(o.body, 600);
  const footer = text.footerSentence(o.because);
  const rows = [['On', label]];
  return {
    subject: 'New comment on ' + label,
    html: text.emailShell({
      heading: o.actorName + ' commented on ' + aboutWords(o.kind),
      bodyHtml: '<p>' + text.escHtml(o.actorName + ' left a comment on ' + aboutWords(o.kind) + '.') + '</p>'
        + text.rowsHtml(rows)
        + '<div style="background:#f9fafb;border:1px solid #e5e7eb;border-left:4px solid #4f8cff;'
        + 'border-radius:6px;margin:16px 0;padding:12px 16px;font-size:14px;white-space:pre-wrap;">'
        + text.escHtml(quote) + '</div>',
      button: { label: 'Open the conversation', href: o.link },
      footerHtml: footer.html,
    }),
    text: o.actorName + ' left a comment on ' + aboutWords(o.kind) + '.\n'
      + '\n' + text.rowsText(rows) + '\n'
      + '\n' + quote + '\n'
      + '\nOpen the conversation: ' + o.link + '\n\n' + footer.text,
    push: {
      title: '💬 ' + o.actorName,
      body: text.pushBody(label, 'Comment', quote),
      url: o.link,
      // One notification per thread on the device: a second comment replaces
      // the first rather than stacking, which is what a conversation wants.
      tag: KEY + ':' + o.threadKey,
    },
  };
}

async function sendAll(db, orgId, users, message, opts) {
  const d = delivery.resolveDeps((opts || {}).deps);
  const senderOrg = await delivery.senderOrgFor(db, orgId);
  let sent = 0;
  for (const u of users) {
    const reached = await delivery.deliver(d, u, KEY, message, {
      orgId: orgId, senderOrg: senderOrg, replyTo: (opts || {}).replyTo,
    });
    if (reached) sent++;
  }
  return sent;
}

/* ── a comment was posted to a thread ─────────────────────────────────────
 *
 * opts: { key, orgId, actorIds: [req.user.id, attributedId], actorName, body,
 *         label, replyTo, deps, now }
 *
 * `label` names the record for the subject line and is the CALLER's, because
 * the human door has already resolved it (describeThread, org-predicated) and
 * nothing is served by resolving it twice. An `attachment:` thread is the
 * exception: its name is the file's own, read here, so 86's tool does not have
 * to know that.
 */
async function notifyThreadComment(db, opts) {
  try {
    const o = opts || {};
    const parts = splitKey(o.key);
    if (!parts) return { sent: 0, skipped: 'bad_key' };
    if (parts.kind === 'dm') return { sent: 0, skipped: 'dm' };   // notifyMessageDM owns those
    const orgId = o.orgId;
    if (orgId == null) return { sent: 0, skipped: 'no_org' };
    const body = text.oneLine(o.body, 600);
    if (!body) return { sent: 0, skipped: 'empty' };
    if (!burstAllowed(o.key, o.now)) return { sent: 0, skipped: 'burst' };

    const photo = parts.kind === 'attachment' ? await photoFacts(db, parts.id, orgId) : null;
    const label = text.oneLine(
      parts.kind === 'attachment' ? ((photo && photo.filename) || ('Photo ' + parts.id)) : o.label,
      160
    ) || o.key;
    const link = threadLink(parts, photo);
    const actorName = text.oneLine(o.actorName, 80) || 'A teammate';
    const skip = (o.actorIds || []).slice();

    const posted = await recipients(db, orgId, await participantIds(db, o.key, orgId), skip, KEY);

    // The uploader is a SEPARATE group, and only when they are not already in
    // the conversation — otherwise one person would get two copies of the same
    // comment with two different reasons on the bottom.
    const alreadyTold = new Set(posted.map((u) => Number(u.id)));
    const uploader = photo && photo.uploaded_by && !alreadyTold.has(Number(photo.uploaded_by))
      ? await recipients(db, orgId, [photo.uploaded_by], skip, KEY)
      : [];

    if (!posted.length && !uploader.length) return { sent: 0, skipped: 'nobody' };

    const common = {
      kind: parts.kind, label: label, link: link, body: body,
      actorName: actorName, threadKey: o.key,
    };
    let sent = 0;
    if (posted.length) {
      sent += await sendAll(db, orgId, posted, commentMessage(Object.assign({}, common, {
        because: 'You are getting this because you have posted in this conversation.',
      })), o);
    }
    if (uploader.length) {
      sent += await sendAll(db, orgId, uploader, commentMessage(Object.assign({}, common, {
        because: 'You are getting this because you uploaded this photo.',
      })), o);
    }
    return { sent: sent, told: posted.length + uploader.length };
  } catch (e) {
    console.warn('[comment-notices] comment notice failed:', e && e.message);
    return { sent: 0, skipped: 'error' };
  }
}

module.exports = {
  KEY,
  PARTICIPANT_CAP,
  BURST_CAP,
  recipients,
  participantIds,
  notifyThreadComment,
  _resetBurst: function () { _burst.clear(); },
};
