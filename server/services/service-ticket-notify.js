'use strict';

// "Flag it for the office to know that the job is complete." — John, 2026-09-13.
//
// When a service ticket reaches work_complete ("Awaiting approval" in the
// office), the people who approve it hear about it by email and phone push:
//
//   • the job's PM (jobs.owner_id) — the person who runs the job,
//   • whoever raised the ticket (service_tickets.created_by),
//   • whoever sent the crew link it came through (service_ticket_shares.created_by),
//
// minus the person who made the move themselves, anyone who can no longer
// approve the ticket (services/service-ticket-access.js in write mode, the rule
// every office write uses), and anyone who has muted it on both channels. Three doors reach
// work_complete and all three call this: the office status change, the crew's
// Mark work complete, and the last subtask being finished (office or crew).
//
// ONE NOTICE PER ARRIVAL, NOT PER CLICK. A crew that finishes the last
// building, undoes it and redoes it has not finished the job three times. The
// send is claimed atomically on service_tickets.approval_notified_at: a ticket
// notified in the last 15 minutes is not notified again, and two requests
// racing to the same arrival cannot both win the UPDATE. The office sending a
// ticket back clears the stamp (routes/service-ticket-routes.js POST
// /:id/status, and an office untick in service-ticket-workorder.js
// setSubtaskDone), and a claim that reached nobody is given back, so neither
// swallows the next real arrival.
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

const svc = require('./service-tickets');
const workOrder = require('./service-ticket-workorder');
const access = require('./service-ticket-access');

const EVENT_KEY = 'ticket_approval';
const DEDUPE = "INTERVAL '15 minutes'";

function appUrl() {
  const u = process.env.APP_URL;
  if (typeof u === 'string' && /^https?:\/\//.test(u.trim())) return u.trim().replace(/\/$/, '');
  return 'https://project86.net';
}

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function positiveInt(v) {
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

// Where the notice points. A job ticket opens on the job's Service Tickets tab
// with this ticket expanded (?ticket= is read by js/service-tickets.js); a lead
// ticket opens the lead.
function ticketLink(ticket) {
  const base = appUrl();
  if (ticket.job_id) {
    return base + '/jobs/' + encodeURIComponent(ticket.job_id) + '/job-service-tickets?ticket=' +
      encodeURIComponent(ticket.id);
  }
  if (ticket.lead_id) return base + '/leads/' + encodeURIComponent(ticket.lead_id);
  return base + '/';
}

/**
 * approvalRecipients(db, ticket, { actorUserId, sharedBy, hasCapability }) -> users[]
 * Active, in-org users in the order PM, ticket creator, link sender — each
 * once, never the person who made the move, and only people who can still
 * APPROVE this ticket — edit its job or lead, by the same rule every office
 * write to the ticket goes through. Raising a ticket or sending its link once
 * is not a standing grant: someone taken off the job since hears nothing.
 */
async function approvalRecipients(db, ticket, opts) {
  opts = opts || {};
  const orgId = ticket && ticket.organization_id;
  if (!ticket || orgId == null) return [];
  const ids = [];
  if (ticket.job_id) {
    const j = await db.query('SELECT owner_id FROM jobs WHERE id = $1 AND organization_id = $2', [ticket.job_id, orgId]);
    if (j.rows[0]) ids.push(positiveInt(j.rows[0].owner_id));
  }
  ids.push(positiveInt(ticket.created_by), positiveInt(opts.sharedBy));
  const actor = positiveInt(opts.actorUserId);
  const wanted = ids.filter(function (id, i) { return id && id !== actor && ids.indexOf(id) === i; });
  if (!wanted.length) return [];
  const r = await db.query(
    'SELECT id, name, email, role, notification_prefs FROM users WHERE id = ANY($1::int[]) AND organization_id = $2 AND active = TRUE',
    [wanted, orgId]
  );
  const out = [];
  for (const id of wanted) {
    const u = r.rows.find(function (row) { return Number(row.id) === id; });
    if (!u) continue;
    // 'write': the notice says "ready for your approval", and approving is an
    // edit. Someone who can only view the job is not someone to ask.
    const verdict = await access.mayAccessTicketParent({
      query: function (sql, params) { return db.query(sql, params); },
      user: { id: u.id, role: u.role },
      parent: ticket,
      mode: 'write',
      orgId: orgId,
      hasCapability: opts.hasCapability,
    });
    if (verdict && verdict.ok) out.push(u);
  }
  return out;
}

// Text a person typed that goes into a subject line, a push body or a plain-text
// email: control characters and line breaks become spaces, so a name cannot
// forge a second line ("Review and approve: <somewhere else>").
function oneLine(s, max) {
  return String(s == null ? '' : s)
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

// The crew's typed name is a CLAIM from whoever holds the link. It is shown as
// a name and nothing else: one line, and only words a name is made of —
// letters, digits, apostrophes, hyphens, and a period that ends an initial
// ("J.R.", "Jr."). A word with a period before two or more characters reads as
// a domain ("p86-review.com", "bit.ly") and mail apps would link it, so it is
// dropped; so is anything carrying a colon, slash, @ or bracket. NFKC first, so
// fullwidth look-alikes ("ｈｔｔｐｓ：／／") fold into the characters refused.
function crewName(label) {
  let text = oneLine(label, 200);
  try { text = text.normalize('NFKC'); } catch (_) { /* keep as typed */ }
  const kept = oneLine(text, 200)
    .split(' ')
    .filter(function (w) {
      return w && /^[\p{L}\p{M}\p{N}'’.\-]+$/u.test(w) && !/\.[\p{L}\p{M}\p{N}]{2,}/u.test(w);
    })
    .join(' ');
  // By code point, not UTF-16 unit, so a cut never leaves half a character.
  return Array.from(kept).slice(0, 60).join('').trim();
}

function prefsOf(u) {
  let p = u && u.notification_prefs;
  if (typeof p === 'string') { try { p = JSON.parse(p); } catch (_) { p = {}; } }
  return (p && typeof p === 'object') ? p : {};
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

/**
 * notifyAwaitingApproval(db, { ticket, actor, reason, sharedBy }, deps?)
 *   -> { sent: number, recipients: number, skipped?: string }
 *
 * reason: 'all_subtasks_done' | 'marked_complete' | 'office_moved'
 * actor:  { kind: 'user'|'share', userId?, label? }
 * deps:   { sendEmail, sendPush, hasCapability } — injected by tests; the real
 *         senders and auth's role cache by default.
 */
async function notifyAwaitingApproval(db, opts, deps) {
  opts = opts || {};
  const ticket = opts.ticket;
  let claimed = false;
  try {
    if (!ticket || !ticket.id || ticket.organization_id == null) return { sent: 0, recipients: 0, skipped: 'no_ticket' };
    const actor = opts.actor || {};
    const sendEmail = (deps && deps.sendEmail) || require('../email').sendEmail;
    const sendPush = (deps && deps.sendPush) || require('../notify-events').sendPushForEvent;

    const candidates = await approvalRecipients(db, ticket, {
      actorUserId: actor.userId, sharedBy: opts.sharedBy, hasCapability: deps && deps.hasCapability,
    });
    // Someone who has muted this notice on both channels is not someone to
    // claim a send for.
    const people = candidates.filter(function (u) {
      const prefs = prefsOf(u);
      const pushOn = !(prefs.push && prefs.push[EVENT_KEY] === false);
      return (u.email && prefs[EVENT_KEY] !== false) || pushOn;
    });
    if (!people.length) return { sent: 0, recipients: 0, skipped: 'no_recipients' };

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

    // The facts the message states — read after the claim, so a notice that
    // is not sent costs nothing.
    const [site, counts] = await Promise.all([
      workOrder.workOrderSite(db, ticket),
      db.query(
        `SELECT id, status FROM tasks
          WHERE service_ticket_id = $1 AND organization_id = $2 AND archived_at IS NULL AND scope = 'org'`,
        [ticket.id, ticket.organization_id]
      ),
    ]);
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
    const who = whoDidIt(actor);
    const how = howItHappened(opts.reason, tasks.length);
    const link = ticketLink(ticket);
    const tally = tasks.length
      ? doneCount + ' of ' + tasks.length + ' subtasks done · ' + completionPhotos + ' completion photo' + (completionPhotos === 1 ? '' : 's')
      : '';

    let sent = 0;
    const notified = [];
    for (const u of people) {
      const prefs = prefsOf(u);
      let reached = false;
      if (u.email && prefs[EVENT_KEY] !== false) {
        const base = appUrl();
        const subject = 'Ready for approval: ' + title + (jobLine ? ' — ' + jobLine : '');
        const html =
          '<!doctype html><html><body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;">' +
            '<div style="max-width:560px;margin:24px auto;padding:24px;background:#fff;border-radius:10px;color:#1f2937;line-height:1.5;">' +
              '<div style="margin-bottom:12px;"><img src="' + base + '/images/logo-color.png" alt="Project 86" style="height:40px;display:block;" /></div>' +
              '<h2 style="margin:0 0 16px 0;color:#111827;font-size:20px;">A work order is ready for your approval</h2>' +
              '<p>Hi ' + escHtml(u.name || 'there') + ',</p>' +
              '<p>' + escHtml(who) + ' ' + escHtml(how) + ' on <strong>' + escHtml(title) + '</strong>.</p>' +
              '<table style="border-collapse:collapse;margin:12px 0;font-size:14px;">' +
                (jobLine ? '<tr><td style="padding:5px 10px;color:#6b7280;">' + parentLabel + '</td><td style="padding:5px 10px;font-weight:600;">' + escHtml(jobLine) + '</td></tr>' : '') +
                (site && site.address ? '<tr><td style="padding:5px 10px;color:#6b7280;">Address</td><td style="padding:5px 10px;">' + escHtml(site.address) + '</td></tr>' : '') +
                (tally ? '<tr><td style="padding:5px 10px;color:#6b7280;">Punch list</td><td style="padding:5px 10px;">' + escHtml(tally) + '</td></tr>' : '') +
              '</table>' +
              '<p><a href="' + escHtml(link) + '" style="display:inline-block;background:#4f8cff;color:#fff;text-decoration:none;padding:10px 20px;border-radius:6px;font-weight:600;">Review and approve</a></p>' +
              '<div style="margin-top:32px;padding-top:16px;border-top:1px solid #e5e7eb;font-size:12px;color:#6b7280;">' +
                'You\'re receiving this because you run this job, raised this ticket, or sent its crew link. ' +
                'Toggle notifications in <strong>My Account &rarr; Notifications</strong>.' +
              '</div>' +
            '</div>' +
          '</body></html>';
        const text =
          'Hi ' + (u.name || 'there') + ',\n\n' +
          who + ' ' + how + ' on "' + title + '".\n' +
          (jobLine ? '\n' + parentLabel + ': ' + jobLine : '') +
          (site && site.address ? '\nAddress: ' + site.address : '') +
          (tally ? '\nPunch list: ' + tally : '') +
          '\n\nReview and approve: ' + link + '\n\n' +
          'Toggle notifications in My Account → Notifications.';
        try {
          const r = await sendEmail({ to: u.email, subject: subject, html: html, text: text, tag: EVENT_KEY });
          if (r && r.ok) reached = true;
        } catch (e) {
          console.warn('[service-ticket-notify] email failed:', e && e.message);
        }
      }
      try {
        const p = await sendPush(Number(u.id), EVENT_KEY, {
          title: '✅ Ready for approval',
          body: (jobLine ? jobLine + ' — ' : '') + title + ': ' + who + ' ' + how + '.',
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
    if (notified.length) try {
      await db.query(
        `INSERT INTO service_ticket_events
           (id, organization_id, ticket_id, kind, actor_kind, actor_user_id, share_id, actor_label, detail)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [svc.genId('ste'), ticket.organization_id, ticket.id, 'approval_notified',
         'system', null, null, null, JSON.stringify({ names: notified, reason: opts.reason || null })]
      );
    } catch (e) {
      console.warn('[service-ticket-notify] event log failed:', e && e.message);
    }

    if (!notified.length) {
      await releaseClaim(db, ticket);
      return { sent: 0, recipients: people.length, skipped: 'nobody_reached' };
    }
    return { sent: sent, recipients: people.length };
  } catch (e) {
    console.warn('[service-ticket-notify] failed:', e && e.message);
    if (claimed) await releaseClaim(db, ticket);
    return { sent: 0, recipients: 0, skipped: 'error' };
  }
}

module.exports = { notifyAwaitingApproval, approvalRecipients, ticketLink, crewName, EVENT_KEY };
