'use strict';

// "Flag it for the office to know that the job is complete." — John, 2026-09-13.
//
// When a service ticket reaches work_complete ("Awaiting approval" in the
// office), the people who approve it hear about it by email and phone push.
// WHO is services/work-order-recipients.js in 'write' mode — the one list every
// work-order notice uses:
//
//   • the job's PM (jobs.owner_id) — the person who runs the job,
//   • whoever raised the ticket (service_tickets.created_by),
//   • whoever sent the crew link it came through (service_ticket_shares.created_by),
//   • whoever it is assigned to (service_tickets.assignee_user_id),
//   • the salesperson, on a ticket that hangs off a lead alone,
//   • the people watching it (service_ticket_participants),
//
// minus the person who made the move themselves, anyone who can no longer
// approve the ticket (services/service-ticket-access.js in write mode, the rule
// every office write uses), and anyone who has muted it on both channels.
// Every door that reaches work_complete calls this: the office status change,
// the crew's Mark work complete, and the last subtask being finished (office or
// crew). The notice cron (server/work-order-notify-cron.js) calls it again with
// reason 'retry', and the office's Notify again button with 'notify_again'.
// Both of those RE-SEND THE ORIGINAL ARRIVAL: the message names whoever
// finished the work, recovered from the ticket's own timeline, never the
// person who asked for it to be sent again. Who RECEIVES it is still decided
// from the caller, so Notify again never tells its own clicker.
//
// ADMIN FALLBACK. When NOBODY on the work order can approve it, the org's
// admins are told instead, and the email says so. Never because people muted
// the notice — muting is a choice. Notify again never falls back: the person
// clicking it already knows.
//
// ONE NOTICE PER ARRIVAL, NOT PER CLICK. A crew that finishes the last
// building, undoes it and redoes it has not finished the job three times. The
// send is claimed atomically on service_tickets.approval_notified_at: a ticket
// notified in the last 15 minutes is not notified again, and two requests
// racing to the same arrival (or a cron retry racing a route arrival or Notify
// again) cannot both win the UPDATE. The office sending a ticket back clears
// the stamp (routes/service-ticket-routes.js POST /:id/status, and an office
// untick in service-ticket-workorder.js setSubtaskDone), and a claim that
// reached nobody is given back, so neither swallows the next real arrival.
//
// RETRY BOOKKEEPING, for the CURRENT arrival (service_tickets columns):
//   approval_notice_attempts     failed tries since this arrival; reset to 0 by
//                                a fresh arrival and by a notice that reached
//                                someone
//   approval_notice_last_try_at  when the last failed try ended
//   approval_notice_gave_up_at   set by the 4th failure, or at once when
//                                everyone who could approve it muted it; drives
//                                the office's "Nobody has been told" banner
// The cron retries 10 minutes, 1 hour and 4 hours after the first failure.
// Notify again touches none of the three unless it claims a send: a click with
// nobody else to tell (or already told in the last 15 minutes) leaves a
// gave-up ticket gave-up and a retrying one on its count. Once it claims, the
// count starts again from zero.
// Every write is `NOW()` DB-side and guarded by `status = 'work_complete'`, so a
// ticket that has moved on stops accumulating attempts.
//
// A crew-typed name is a claim from whoever holds the link: it is flattened to
// one line with no link-like words before it goes into a subject, a push body
// or an email.
//
// NO MONEY: the message names the job, the ticket, who finished it and how many
// subtasks and completion photos it carries. Nothing else is read.
//
// BEST-EFFORT: never throws. A failed notice must not fail the write that
// triggered it — the ticket is Awaiting approval either way, and the office
// list says so.
//
// Tenancy: every statement carries `organization_id = $n` from the ticket row
// the caller already proved (office) or the token already resolved (link).
//
// SENDER AND REPLY-TO. The email names the company ("AG Exteriors via Project
// 86") from the ticket's org, and a reply reaches the person who finished the
// work: an office actor's fresh users row in the ticket's org (none under
// act-as, where the actor is platform staff), or, for the crew link, the
// address the office typed when it minted that link — re-read by share id in
// the ticket's org, never a value passed through and never the crew-typed
// name. A link with no address on file sends no Reply-To.
//
// crewName, oneLine, escHtml, appUrl and ticketLink live in
// services/work-order-notify-text.js and are re-exported here unchanged.

const svc = require('./service-tickets');
const workOrder = require('./service-ticket-workorder');
const recipients = require('./work-order-recipients');
const notifyText = require('./work-order-notify-text');

const { appUrl, escHtml, oneLine, crewName, ticketLink } = notifyText;

const EVENT_KEY = 'ticket_approval';
const DEDUPE = "INTERVAL '15 minutes'";
// The 4th failed try gives up (the first try plus the cron's three retries).
const GIVE_UP_AFTER = 4;

const FALLBACK_SENTENCE = 'Nobody on this work order can approve it, so it came to you as a company admin.';
const SYSTEM_SENTENCE = 'This work order is ready for your approval.';

function positiveInt(v) {
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function parsedDetail(v) {
  let d = v;
  if (typeof d === 'string') { try { d = JSON.parse(d); } catch (_) { d = {}; } }
  return (d && typeof d === 'object') ? d : {};
}

/**
 * approvalRecipients(db, ticket, { actorUserId, sharedBy, hasCapability, fallbackToAdmins }) -> users[]
 * Active, in-org users in the order PM, ticket creator, link sender, assignee,
 * lead salesperson (lead-only tickets), participants — each once, never the
 * person who made the move, and only people who can still APPROVE this ticket.
 * fallbackToAdmins defaults to FALSE here, so a caller asking "who is on it"
 * gets exactly that; notifyAwaitingApproval asks for the fallback itself.
 */
async function approvalRecipients(db, ticket, opts) {
  const o = opts || {};
  if (!ticket || ticket.organization_id == null) return [];
  const found = await recipients.ticketRecipients(db, ticket, {
    mode: 'write',
    actorUserId: o.actorUserId,
    sharedBy: o.sharedBy,
    hasCapability: o.hasCapability,
    fallbackToAdmins: o.fallbackToAdmins === true,
  });
  return found.users;
}

function prefsOf(u) {
  let p = u && u.notification_prefs;
  if (typeof p === 'string') { try { p = JSON.parse(p); } catch (_) { p = {}; } }
  return (p && typeof p === 'object') ? p : {};
}

// Preferences (server/notify-events.js): email is off when prefs[key] ===
// false, push is off when prefs.push[key] === false. Missing means on.
function emailOn(u) {
  return !!(u && u.email) && prefsOf(u)[EVENT_KEY] !== false;
}

function pushOn(u) {
  const prefs = prefsOf(u);
  return !(prefs.push && typeof prefs.push === 'object' && prefs.push[EVENT_KEY] === false);
}

// What the crew did, in a sentence. The actor label on a link is a CLAIM —
// typed by whoever holds the link — so it is presented as "via the crew link".
function whoDidIt(actor) {
  if (actor && actor.kind === 'share') {
    const name = crewName(actor.label);
    return name ? name + ' (via the crew link)' : 'The crew link';
  }
  return oneLine(actor && actor.label, 80) || 'A teammate';
}

// Worded after what the office sees: the status is "Work complete", and the
// list filter that holds it is "Awaiting approval".
function howItHappened(reason, total) {
  if (reason === 'all_subtasks_done') {
    return total > 1 ? 'finished the last of ' + total + ' subtasks' : 'finished the last subtask';
  }
  if (reason === 'marked_complete') return 'marked the work complete';
  return 'moved it to Work complete';
}

async function logEvent(db, ticket, kind, detail) {
  try {
    await db.query(
      `INSERT INTO service_ticket_events
         (id, organization_id, ticket_id, kind, actor_kind, actor_user_id, share_id, actor_label, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [svc.genId('ste'), ticket.organization_id, ticket.id, kind,
       'system', null, null, null, JSON.stringify(detail || {})]
    );
  } catch (e) {
    console.warn('[service-ticket-notify] event log failed (' + kind + '):', e && e.message);
  }
}

// Given back when a claimed notice reached nobody (every channel muted, email
// down, no phone subscribed) or failed part-way, so the next real arrival is
// still announced. Unconditional on the timestamp. An office send-back can
// clear the stamp mid-send and let a second claim in; releasing that one too
// costs at most a repeated notice later — never a missed one.
async function releaseClaim(db, ticket) {
  try {
    await db.query(
      'UPDATE service_tickets SET approval_notified_at = NULL WHERE id = $1 AND organization_id = $2',
      [ticket.id, ticket.organization_id]
    );
  } catch (e) {
    console.warn('[service-ticket-notify] claim release failed:', e && e.message);
  }
}

// A fresh arrival (not a cron retry) starts its own count.
async function resetForArrival(db, ticket) {
  await db.query(
    `UPDATE service_tickets
        SET approval_notice_attempts = 0, approval_notice_last_try_at = NULL, approval_notice_gave_up_at = NULL
      WHERE id = $1 AND organization_id = $2 AND status = 'work_complete'`,
    [ticket.id, ticket.organization_id]
  );
}

// One failed try. The 4th sets gave_up and says so on the timeline, once.
async function recordFailure(db, ticket, reason) {
  try {
    const r = await db.query(
      `UPDATE service_tickets
          SET approval_notice_attempts = COALESCE(approval_notice_attempts, 0) + 1,
              approval_notice_last_try_at = NOW(),
              approval_notice_gave_up_at = CASE WHEN COALESCE(approval_notice_attempts, 0) + 1 >= 4 THEN NOW() ELSE approval_notice_gave_up_at END
        WHERE id = $1 AND organization_id = $2 AND status = 'work_complete'
        RETURNING approval_notice_attempts, approval_notice_gave_up_at`,
      [ticket.id, ticket.organization_id]
    );
    const row = r.rows[0];
    if (!row) return null;
    const attempts = Number(row.approval_notice_attempts) || 0;
    if (row.approval_notice_gave_up_at && attempts === GIVE_UP_AFTER) {
      await logEvent(db, ticket, 'approval_notice_failed', { attempts: attempts, reason: reason });
    }
    return { attempts: attempts, gave_up: !!row.approval_notice_gave_up_at };
  } catch (e) {
    console.warn('[service-ticket-notify] failure bookkeeping failed:', e && e.message);
    return null;
  }
}

// Everyone who could approve it has muted it: nothing a retry could change, so
// the office is shown "Nobody has been told" at once.
async function giveUpMuted(db, ticket) {
  try {
    const r = await db.query(
      `UPDATE service_tickets
          SET approval_notice_attempts = 4, approval_notice_last_try_at = NOW(), approval_notice_gave_up_at = NOW()
        WHERE id = $1 AND organization_id = $2 AND status = 'work_complete'
        RETURNING id`,
      [ticket.id, ticket.organization_id]
    );
    if (r.rows[0]) await logEvent(db, ticket, 'approval_notice_failed', { attempts: GIVE_UP_AFTER, reason: 'muted' });
  } catch (e) {
    console.warn('[service-ticket-notify] give-up bookkeeping failed:', e && e.message);
  }
}

async function recordSuccess(db, ticket) {
  try {
    await db.query(
      `UPDATE service_tickets
          SET approval_notice_attempts = 0, approval_notice_last_try_at = NULL, approval_notice_gave_up_at = NULL
        WHERE id = $1 AND organization_id = $2`,
      [ticket.id, ticket.organization_id]
    );
  } catch (e) {
    console.warn('[service-ticket-notify] success bookkeeping failed:', e && e.message);
  }
}

// A cron retry reads like the original notice: who moved the ticket to Work
// complete is recovered from its latest status change. When that change is not
// an arrival at work_complete, the notice is the system's own.
async function recoverArrival(db, ticket) {
  const orgId = ticket.organization_id;
  const r = await db.query(
    `SELECT actor_kind, actor_user_id, share_id, actor_label, detail FROM service_ticket_events
      WHERE ticket_id = $1 AND organization_id = $2 AND kind = 'status_changed'
      ORDER BY created_at DESC LIMIT 1`,
    [ticket.id, orgId]
  );
  const ev = r.rows[0];
  const detail = parsedDetail(ev && ev.detail);
  if (ev && detail.to === 'work_complete') {
    if (ev.actor_kind === 'share') {
      let sharedBy = null;
      if (ev.share_id) {
        const s = await db.query(
          'SELECT created_by FROM service_ticket_shares WHERE id = $1 AND organization_id = $2',
          [ev.share_id, orgId]
        );
        sharedBy = s.rows[0] ? s.rows[0].created_by : null;
      }
      return {
        actor: { kind: 'share', shareId: ev.share_id || null, label: ev.actor_label || null },
        sharedBy: sharedBy,
        how: detail.reason === 'all_subtasks_done' ? 'all_subtasks_done' : 'marked_complete',
      };
    }
    if (ev.actor_kind === 'user' && positiveInt(ev.actor_user_id)) {
      const u = await db.query('SELECT name FROM users WHERE id = $1 AND organization_id = $2',
        [positiveInt(ev.actor_user_id), orgId]);
      return {
        actor: { kind: 'user', userId: positiveInt(ev.actor_user_id), label: (u.rows[0] && u.rows[0].name) || null },
        sharedBy: null,
        how: detail.reason === 'all_subtasks_done' ? 'all_subtasks_done' : 'office_moved',
      };
    }
  }
  return { actor: { kind: 'system' }, sharedBy: null, how: null };
}

// Who a reply to the notice should reach — the person who finished the work —
// or null. Resolved once per notice, before the per-recipient loop. Never
// throws: a lookup that fails costs the Reply-To, not the notice.
//   office actor -> that user's email, active and in the ticket's org
//   crew link    -> service_ticket_shares.recipient_email, written once by the
//                   office at mint and never by a guest route; loaded by the
//                   share id in the ticket's org, not taken from the caller
async function replyToForActor(db, ticket, actor, sender) {
  try {
    const orgId = ticket.organization_id;
    if (actor && actor.kind === 'share') {
      if (!actor.shareId) return null;
      const r = await db.query(
        'SELECT recipient_email FROM service_ticket_shares WHERE id = $1 AND organization_id = $2',
        [actor.shareId, orgId]
      );
      return (r.rows[0] && sender.cleanReplyTo(r.rows[0].recipient_email, [])) || null;
    }
    if (actor && actor.kind !== 'system' && actor.userId != null) {
      return (await sender.replyToForUser(db, actor.userId, orgId)) || null;
    }
  } catch (e) {
    console.warn('[service-ticket-notify] reply-to lookup failed:', e && e.message);
  }
  return null;
}

/**
 * notifyAwaitingApproval(db, { ticket, actor, reason, sharedBy, fallbackToAdmins }, deps?)
 *   -> { sent: number, recipients: number, skipped?: string }
 *
 * reason: 'all_subtasks_done' | 'marked_complete' | 'office_moved' | 'retry' | 'notify_again'
 * actor:  { kind: 'user'|'share'|'system', userId?, shareId?, label? }
 *         (ignored for 'retry', which recovers the original mover; for
 *         'notify_again' it picks the recipients — the clicker is excluded —
 *         and the wording is recovered from the arrival the same way)
 * fallbackToAdmins: default true; false for 'notify_again'
 * deps:   { sendEmail, sendPush, hasCapability } — injected by tests; the real
 *         senders and auth's role cache by default.
 * skipped: 'no_ticket' | 'no_recipients' | 'already_notified' | 'nobody_reached' | 'error'
 */
async function notifyAwaitingApproval(db, opts, deps) {
  opts = opts || {};
  const ticket = opts.ticket;
  let claimed = false;
  let everClaimed = false;
  try {
    if (!ticket || !ticket.id || ticket.organization_id == null) return { sent: 0, recipients: 0, skipped: 'no_ticket' };
    const reason = opts.reason || null;
    const isRetry = reason === 'retry';
    // Notify again changes no bookkeeping unless it claims a send. Resetting
    // or counting before that would turn a click with nobody else to tell into
    // a fresh retry schedule — whose cron retry falls back to the admins the
    // clicker chose not to involve — or restart the count of a ticket already
    // retrying.
    const isNotifyAgain = reason === 'notify_again';
    const fallbackToAdmins = opts.fallbackToAdmins === undefined
      ? reason !== 'notify_again'
      : opts.fallbackToAdmins === true;
    const sendEmail = (deps && deps.sendEmail) || require('../email').sendEmail;
    const sendPush = (deps && deps.sendPush) || require('../notify-events').sendPushForEvent;
    // Never mocked, holds no state beyond a name cache; lazy like the senders.
    const sender = require('../email-sender');

    let actor = opts.actor || {};
    let sharedBy = opts.sharedBy;
    let how = reason;
    let attempt = null;
    if (isRetry) {
      attempt = (Number(ticket.approval_notice_attempts) || 0) + 1;
      const recovered = await recoverArrival(db, ticket);
      actor = recovered.actor;
      sharedBy = recovered.sharedBy;
      how = recovered.how;
    } else if (!isNotifyAgain) {
      await resetForArrival(db, ticket);
    }

    const found = await recipients.ticketRecipients(db, ticket, {
      mode: 'write',
      actorUserId: actor.kind === 'system' ? null : actor.userId,
      sharedBy: sharedBy,
      hasCapability: deps && deps.hasCapability,
      fallbackToAdmins: fallbackToAdmins,
    });
    const candidates = found.users;
    const fallback = found.fallback === 'admins' ? 'admins' : null;
    // Someone who has muted this notice on both channels is not someone to
    // claim a send for.
    const people = candidates.filter(function (u) { return emailOn(u) || pushOn(u); });
    if (!people.length) {
      // A gave-up ticket stays gave-up and a retrying one keeps its count.
      if (!isNotifyAgain) {
        if (candidates.length) await giveUpMuted(db, ticket);
        else await recordFailure(db, ticket, 'no_recipients');
      }
      return { sent: 0, recipients: 0, skipped: 'no_recipients' };
    }

    // The claim. Only a ticket that is STILL awaiting approval, and has not
    // been announced in the last 15 minutes, is announced now.
    const claim = await db.query(
      `UPDATE service_tickets SET approval_notified_at = NOW()
        WHERE id = $1 AND organization_id = $2 AND status = 'work_complete'
          AND (approval_notified_at IS NULL OR approval_notified_at < NOW() - ${DEDUPE})
        RETURNING id`,
      [ticket.id, ticket.organization_id]
    );
    if (!claim.rows[0]) return { sent: 0, recipients: people.length, skipped: 'already_notified' };
    claimed = true;
    everClaimed = true;
    // Notify again has claimed a send: from here it is a fresh try, so a
    // failure starts the retry schedule from its first step ("It will be tried
    // again automatically"), even on a ticket that had given up.
    if (isNotifyAgain) await resetForArrival(db, ticket);
    // Notify again RE-SENDS THE ORIGINAL ARRIVAL'S NOTICE: it is worded after
    // whoever finished the work — the crew on the link, or the office person
    // who moved it — not after the office person clicking the button hours
    // later. Wording only: the recipients were already chosen above (the
    // clicker is out of them, and the link sender is in), so recovering here
    // moves nobody in or out of the list. An arrival that cannot be recovered
    // comes back as the system actor and degrades to SYSTEM_SENTENCE with no
    // Reply-To, exactly as the cron retry does.
    if (isNotifyAgain) {
      const recovered = await recoverArrival(db, ticket);
      actor = recovered.actor;
      how = recovered.how;
    }

    // The facts the message states — read after the claim, so a notice that
    // is not sent costs nothing.
    const [site, counts, orgName, actorReplyTo] = await Promise.all([
      workOrder.workOrderSite(db, ticket),
      db.query(
        `SELECT id, status FROM tasks
          WHERE service_ticket_id = $1 AND organization_id = $2 AND archived_at IS NULL AND scope = 'org'`,
        [ticket.id, ticket.organization_id]
      ),
      sender.orgNameFor(db, ticket.organization_id),
      replyToForActor(db, ticket, actor, sender),
    ]);
    const senderOrg = orgName ? { id: ticket.organization_id, name: orgName } : { id: ticket.organization_id };
    const tasks = counts.rows;
    const doneCount = tasks.filter(function (t) { return t.status === 'done'; }).length;
    const photos = await workOrder.taskPhotosByTask(db, ticket.organization_id, tasks.map(function (t) { return t.id; }));
    let completionPhotos = 0;
    photos.forEach(function (list) {
      completionPhotos += list.filter(function (p) { return p.kind !== 'before'; }).length;
    });

    const title = oneLine(ticket.title, 200) || 'Service ticket';
    const jobLine = oneLine([site && site.job_number, site && site.name].filter(Boolean).join(' · '), 200);
    // A ticket on a lead names the lead, and is labelled as one.
    const parentLabel = ticket.job_id ? 'Job' : 'Lead';
    const systemNotice = actor.kind === 'system';
    const who = whoDidIt(actor);
    const happened = howItHappened(how, tasks.length);
    const link = ticketLink(ticket);
    const tally = tasks.length
      ? doneCount + ' of ' + tasks.length + ' subtasks done · ' + completionPhotos + ' completion photo' + (completionPhotos === 1 ? '' : 's')
      : '';
    const leadHtml = systemNotice
      ? '<p>' + escHtml(SYSTEM_SENTENCE) + '</p>'
      : '<p>' + escHtml(who) + ' ' + escHtml(happened) + ' on <strong>' + escHtml(title) + '</strong>.</p>';
    const leadText = systemNotice
      ? SYSTEM_SENTENCE + '\n'
      : who + ' ' + happened + ' on "' + title + '".\n';
    const footerHtml = fallback
      ? 'You\'re receiving this because you\'re an admin and nobody on this work order can approve it. '
      : 'You\'re receiving this because you run this job, raised this ticket, sent its crew link, are assigned to it, sell this lead, or are watching it. ';

    let sent = 0;
    const notified = [];
    for (const u of people) {
      const prefs = prefsOf(u);
      let reached = false;
      if (emailOn(u)) {
        const base = appUrl();
        const subject = 'Ready for approval: ' + title + (jobLine ? ' — ' + jobLine : '');
        const html =
          '<!doctype html><html><body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;">' +
            '<div style="max-width:560px;margin:24px auto;padding:24px;background:#fff;border-radius:10px;color:#1f2937;line-height:1.5;">' +
              '<div style="margin-bottom:12px;"><img src="' + base + '/images/logo-color.png" alt="Project 86" style="height:40px;display:block;" /></div>' +
              '<h2 style="margin:0 0 16px 0;color:#111827;font-size:20px;">A work order is ready for your approval</h2>' +
              '<p>Hi ' + escHtml(u.name || 'there') + ',</p>' +
              leadHtml +
              (fallback ? '<p>' + escHtml(FALLBACK_SENTENCE) + '</p>' : '') +
              '<table style="border-collapse:collapse;margin:12px 0;font-size:14px;">' +
                (jobLine ? '<tr><td style="padding:5px 10px;color:#6b7280;">' + parentLabel + '</td><td style="padding:5px 10px;font-weight:600;">' + escHtml(jobLine) + '</td></tr>' : '') +
                (site && site.address ? '<tr><td style="padding:5px 10px;color:#6b7280;">Address</td><td style="padding:5px 10px;">' + escHtml(site.address) + '</td></tr>' : '') +
                (tally ? '<tr><td style="padding:5px 10px;color:#6b7280;">Punch list</td><td style="padding:5px 10px;">' + escHtml(tally) + '</td></tr>' : '') +
              '</table>' +
              '<p><a href="' + escHtml(link) + '" style="display:inline-block;background:#4f8cff;color:#fff;text-decoration:none;padding:10px 20px;border-radius:6px;font-weight:600;">Review and approve</a></p>' +
              '<div style="margin-top:32px;padding-top:16px;border-top:1px solid #e5e7eb;font-size:12px;color:#6b7280;">' +
                footerHtml +
                'Toggle notifications in <strong>My Account &rarr; Notifications</strong>.' +
              '</div>' +
            '</div>' +
          '</body></html>';
        const text =
          'Hi ' + (u.name || 'there') + ',\n\n' +
          leadText +
          (fallback ? FALLBACK_SENTENCE + '\n' : '') +
          (jobLine ? '\n' + parentLabel + ': ' + jobLine : '') +
          (site && site.address ? '\nAddress: ' + site.address : '') +
          (tally ? '\nPunch list: ' + tally : '') +
          '\n\nReview and approve: ' + link + '\n\n' +
          'Toggle notifications in My Account → Notifications.';
        try {
          const r = await sendEmail({
            to: u.email, subject: subject, html: html, text: text, tag: EVENT_KEY,
            organizationId: ticket.organization_id,
            senderOrg: senderOrg,
            // Dropped for the one approver who IS that address (a PM who sent
            // the link to themselves): a reply to yourself is noise.
            replyTo: sender.cleanReplyTo(actorReplyTo, [u.email]) || false,
          });
          if (r && r.ok) reached = true;
        } catch (e) {
          console.warn('[service-ticket-notify] email failed:', e && e.message);
        }
      }
      try {
        const p = await sendPush(Number(u.id), EVENT_KEY, {
          title: '✅ Ready for approval',
          body: (jobLine ? jobLine + ' — ' : '') + title + ': ' +
            (systemNotice ? 'ready for your approval.' : who + ' ' + happened + '.'),
          url: link,
          // Per ticket, so two tickets finishing the same afternoon do not
          // replace each other's notification on the phone.
          tag: EVENT_KEY + ':' + ticket.id,
        }, prefs);
        if (p && p.sent) reached = true;
      } catch (e) {
        console.warn('[service-ticket-notify] push failed:', e && e.message);
      }
      if (reached) { sent++; notified.push(String(u.name || u.email || 'User ' + u.id).slice(0, 80)); }
    }

    // On the ticket's timeline, so "did the office hear about it?" has an
    // answer on the ticket itself. Only when someone was actually reached —
    // a row saying "notified nobody" would read as though the office knew.
    if (notified.length) {
      const detail = { names: notified, reason: reason };
      if (fallback) detail.fallback = 'admins';
      if (isRetry) detail.attempt = attempt;
      await logEvent(db, ticket, 'approval_notified', detail);
    }

    if (!notified.length) {
      await releaseClaim(db, ticket);
      claimed = false;
      await recordFailure(db, ticket, 'nobody_reached');
      return { sent: 0, recipients: people.length, skipped: 'nobody_reached' };
    }
    await recordSuccess(db, ticket);
    return { sent: sent, recipients: people.length };
  } catch (e) {
    console.warn('[service-ticket-notify] failed:', e && e.message);
    if (ticket && ticket.id && ticket.organization_id != null) {
      if (claimed) await releaseClaim(db, ticket);
      // Notify again that never claimed a send leaves the counts as they were.
      if (everClaimed || opts.reason !== 'notify_again') await recordFailure(db, ticket, 'error');
    }
    return { sent: 0, recipients: 0, skipped: 'error' };
  }
}

module.exports = {
  notifyAwaitingApproval,
  approvalRecipients,
  ticketLink,
  crewName,
  oneLine,
  escHtml,
  appUrl,
  EVENT_KEY,
};
