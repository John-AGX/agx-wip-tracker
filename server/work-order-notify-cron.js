// WORK-ORDER NOTICE CRON — the notices nobody clicks a button for.
//
// Every 5 minutes (first run 75 s after boot), one pass over every live
// organization, one org at a time, every statement predicated on that org:
//
//   A. APPROVAL RETRIES (services/service-ticket-notify.js)
//      A1  a claim whose process died between the claim and the send (the
//          stamp is 15 minutes to 2 days old and no approval_notified event
//          followed it) is released and counted as a failed try.
//      A2  due retries: a work order at Work complete that nobody has been
//          told about is tried again — 10 minutes after arriving when the
//          route never got to try (a crash or a deploy; only within 14 days,
//          so a deploy does not re-announce old history), then 10 minutes,
//          1 hour and 4 hours after each failed try. The 4th failure gives up
//          and the office sees "Nobody has been told". The notice's own
//          15-minute claim keeps a retry, a crew arrival and Notify again from
//          announcing the same arrival twice.
//
//   C. CREW ACTIVITY (services/work-order-notices.js sendCrewActivityBatch)
//      What crews did on the link, read from the timeline the guest routes
//      already write (actor_kind 'share'), at most one notice per work order
//      every 30 minutes: a work order becomes a candidate when its crew has
//      been quiet for 5 minutes or busy for 20. The batch window is claimed
//      atomically (crew_activity_prev_notified_at / crew_activity_notified_at,
//      both NOW()), and the events are read DB-side between the two stamps,
//      so no event is told twice and none is lost.
//
//   D. MORNING DIGEST / WAITING REMINDER (services/work-order-attention.js)
//      Since 1.33 the digest also carries the WORK ORDERS ASSIGNED TO THE
//      RECIPIENT THAT STILL HAVE OPEN BUILDINGS (the your_buildings section),
//      and carries them first. It has to: a building is off every task list now
//      (the owner's rule — a service ticket is not a task), and the daily task
//      email in reminders-cron.js stopped naming one in the same release.
//      1.35 moved that section's key from the BUILDING to the RECORD (the
//      owner: "whoever is assigned to the ticket, task or work order is evenly
//      responsible") — it reads service_tickets.assignee_user_id, which the
//      office actually sets, and never a building's own. It is keyed on that
//      assignment alone and not on job access, so this is the one notice that
//      reaches a crew lead assigned a work order on a job they cannot open. The
//      assembly below passes entry.sections through whole and enumerates no
//      section, so the row arrives without a change here.
//      Weekdays, per person, between 7:00 and 12:00 in their own zone (user,
//      then org): one digest when anything needs them, or — for someone with
//      the digest off — the standalone "Still waiting for approval" reminder
//      for work orders waiting more than the org's N business days. The
//      reminder is decided on what was DELIVERED, not on a pref: a digest
//      whose email is off and whose push reached no device falls through to
//      the reminder in the same pass, because nothing retries the day. Once per
//      person per local day, recorded in app_settings('work_order_notify_log')
//      as {fires: {'digest|<uid>|<localDate>': ms}}, pruned past 14 days and
//      saved after each org. A person is recorded once processed, sent or not.
//      The log is one global row (the reminders_log pattern): fine for one
//      replica.
//
// ISOLATION (the Register 3 property): each org's assembly reads only that
// org's rows and delivers only to that org's people; every email carries the
// ticket's own org as senderOrg / organizationId, and the digest and reminder
// set no Reply-To.
//
// SHUTDOWN: every tick is tracked by services/inflight.js; a tick is skipped
// while the server is closing or while the previous tick is still running;
// timers are unref()'d. runOnce also stops between orgs once closing begins,
// saving the fire log first. Anything cut off is picked up by step A.
//
// runOnce({dry, now, deps}) -> {dry, approvals:{released, candidates, retried,
//   gave_up}, crew:{candidates, batches, sent}, digest:{users, digests,
//   reminders, skipped}}
//   dry   counts only: no claims, no sends, no fire-log writes
//   now   the clock for calendar decisions (weekday, local hour, local day);
//         stored instants are always compared DB-side against NOW()
//   deps  {db, sendEmail, sendPush, hasCapability, openFlags}
// Never throws.
'use strict';

const tz = require('./timezone');
const inflight = require('./services/inflight');

const TICK_MS = 5 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 75 * 1000;
const LOG_KEY = 'work_order_notify_log';
const LOG_KEEP_MS = 14 * 24 * 60 * 60 * 1000;
const DIGEST_KEY = 'work_order_digest';
const WAITING_KEY = 'ticket_waiting';

function recipientsModule() { return require('./services/work-order-recipients'); }
function noticesModule() { return require('./services/work-order-notices'); }
function notifyModule() { return require('./services/service-ticket-notify'); }
function attentionModule() { return require('./services/work-order-attention'); }
function textModule() { return require('./services/work-order-notify-text'); }

function resolveDeps(deps) {
  const d = deps || {};
  return {
    db: d.db || require('./db').pool,
    sendEmail: d.sendEmail || function (m) { return require('./email').sendEmail(m); },
    sendPush: d.sendPush || function (userId, key, payload, prefs) {
      return require('./notify-events').sendPushForEvent(userId, key, payload, prefs);
    },
    hasCapability: d.hasCapability,
    openFlags: d.openFlags,
  };
}

function noticeDeps(d) {
  return { sendEmail: d.sendEmail, sendPush: d.sendPush, hasCapability: d.hasCapability };
}

function prefsOf(u) {
  let p = u && u.notification_prefs;
  if (typeof p === 'string') { try { p = JSON.parse(p); } catch (_) { p = {}; } }
  return (p && typeof p === 'object') ? p : {};
}

function emailOn(u, key) {
  return !!(u && u.email) && prefsOf(u)[key] !== false;
}

function pushOn(u, key) {
  const prefs = prefsOf(u);
  return !(prefs.push && typeof prefs.push === 'object' && prefs.push[key] === false);
}

function crewKindsSql() {
  return noticesModule().CREW_BATCH_KINDS.map(function (k) {
    if (!/^[a-z_]+$/.test(k)) throw new Error('work-order-notify: bad crew event kind');
    return "'" + k + "'";
  }).join(', ');
}

// ── A. approval retries ───────────────────────────────────────────────────
async function releaseStaleClaims(db, org, out, dry) {
  const stale = await db.query(
    `SELECT t.id, t.organization_id FROM service_tickets t
      WHERE t.organization_id = $1 AND t.status = 'work_complete' AND t.archived_at IS NULL
        AND t.approval_notified_at < NOW() - INTERVAL '15 minutes'
        AND t.approval_notified_at > NOW() - INTERVAL '2 days'
        AND NOT EXISTS (
          SELECT 1 FROM service_ticket_events e
           WHERE e.ticket_id = t.id AND e.organization_id = t.organization_id
             AND e.kind = 'approval_notified' AND e.created_at >= t.approval_notified_at)
      LIMIT 100`,
    [org.id]
  );
  for (const row of stale.rows) {
    if (dry) { out.approvals.released++; continue; }
    const r = await db.query(
      `UPDATE service_tickets
          SET approval_notified_at = NULL,
              approval_notice_attempts = COALESCE(approval_notice_attempts, 0) + 1,
              approval_notice_last_try_at = NOW(),
              approval_notice_gave_up_at = CASE WHEN COALESCE(approval_notice_attempts, 0) + 1 >= 4 THEN NOW() ELSE approval_notice_gave_up_at END
        WHERE id = $1 AND organization_id = $2 AND status = 'work_complete'
          AND approval_notified_at < NOW() - INTERVAL '15 minutes'
        RETURNING id, approval_notice_attempts, approval_notice_gave_up_at`,
      [row.id, org.id]
    );
    const released = r.rows[0];
    if (!released) continue;
    out.approvals.released++;
    // A release that used up the last try gives up like any 4th failure, and
    // says so on the timeline once.
    if (released.approval_notice_gave_up_at && Number(released.approval_notice_attempts) === 4) {
      out.approvals.gave_up++;
      try {
        await db.query(
          `INSERT INTO service_ticket_events
             (id, organization_id, ticket_id, kind, actor_kind, actor_user_id, share_id, actor_label, detail)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [require('./services/service-tickets').genId('ste'), org.id, row.id, 'approval_notice_failed',
           'system', null, null, null, JSON.stringify({ attempts: 4, reason: 'error' })]
        );
      } catch (e) {
        console.warn('[work-order-notify] event log failed:', e && e.message);
      }
    }
  }
}

async function retryDueApprovals(d, org, out, dry) {
  const db = d.db;
  const due = await db.query(
    `SELECT ${recipientsModule().NOTICE_TICKET_COLS} FROM service_tickets
      WHERE organization_id = $1 AND status = 'work_complete' AND archived_at IS NULL
        AND approval_notified_at IS NULL AND approval_notice_gave_up_at IS NULL
        AND ((COALESCE(approval_notice_attempts, 0) = 0
              AND COALESCE(completed_at, updated_at) < NOW() - INTERVAL '10 minutes'
              AND COALESCE(completed_at, updated_at) > NOW() - INTERVAL '14 days')
          OR (approval_notice_attempts = 1 AND approval_notice_last_try_at < NOW() - INTERVAL '10 minutes')
          OR (approval_notice_attempts = 2 AND approval_notice_last_try_at < NOW() - INTERVAL '60 minutes')
          OR (approval_notice_attempts = 3 AND approval_notice_last_try_at < NOW() - INTERVAL '240 minutes'))
      ORDER BY completed_at ASC
      LIMIT 50`,
    [org.id]
  );
  out.approvals.candidates += due.rows.length;
  if (dry) return;
  for (const ticket of due.rows) {
    if (inflight.isClosing()) return;
    await inflight.track(notifyModule().notifyAwaitingApproval(db, {
      ticket: ticket, actor: { kind: 'system' }, reason: 'retry',
    }, noticeDeps(d)), 'ticket_approval_retry');
    out.approvals.retried++;
    try {
      const after = await db.query(
        'SELECT approval_notice_gave_up_at FROM service_tickets WHERE id = $1 AND organization_id = $2',
        [ticket.id, org.id]
      );
      if (after.rows[0] && after.rows[0].approval_notice_gave_up_at) out.approvals.gave_up++;
    } catch (_) { /* a count, not a decision */ }
  }
}

// ── C. crew activity batches ──────────────────────────────────────────────
async function crewBatches(d, org, out, dry) {
  const db = d.db;
  const kinds = crewKindsSql();
  const candidates = await db.query(
    `SELECT t.id, t.organization_id FROM service_tickets t
       JOIN service_ticket_events e ON e.ticket_id = t.id AND e.organization_id = t.organization_id
      WHERE t.organization_id = $1 AND t.archived_at IS NULL
        AND e.actor_kind = 'share' AND e.kind IN (${kinds})
        AND e.created_at > NOW() - INTERVAL '2 days'
        AND e.created_at > COALESCE(t.crew_activity_notified_at, NOW() - INTERVAL '40 minutes')
        AND (t.crew_activity_notified_at IS NULL OR t.crew_activity_notified_at < NOW() - INTERVAL '30 minutes')
      GROUP BY t.id, t.organization_id
     HAVING MAX(e.created_at) < NOW() - INTERVAL '5 minutes' OR MIN(e.created_at) < NOW() - INTERVAL '20 minutes'
      LIMIT 200`,
    [org.id]
  );
  out.crew.candidates += candidates.rows.length;
  if (dry) return;
  for (const row of candidates.rows) {
    if (inflight.isClosing()) return;
    // The claim: this window is ours, and nobody else's, for 30 minutes.
    const claim = await db.query(
      `UPDATE service_tickets
          SET crew_activity_prev_notified_at = crew_activity_notified_at, crew_activity_notified_at = NOW()
        WHERE id = $1 AND organization_id = $2
          AND (crew_activity_notified_at IS NULL OR crew_activity_notified_at < NOW() - INTERVAL '30 minutes')
        RETURNING ${recipientsModule().NOTICE_TICKET_COLS}`,
      [row.id, org.id]
    );
    const ticket = claim.rows[0];
    if (!ticket) continue;
    out.crew.batches++;
    const events = await db.query(
      `SELECT e.id, e.kind, e.actor_kind, e.share_id, e.actor_label, e.detail, e.created_at
         FROM service_ticket_events e
         JOIN service_tickets t ON t.id = e.ticket_id AND t.organization_id = e.organization_id
        WHERE e.ticket_id = $1 AND e.organization_id = $2
          AND e.actor_kind = 'share' AND e.kind IN (${kinds})
          AND e.created_at > NOW() - INTERVAL '2 days'
          AND e.created_at > COALESCE(t.crew_activity_prev_notified_at, NOW() - INTERVAL '40 minutes')
          AND e.created_at <= t.crew_activity_notified_at
        ORDER BY e.created_at ASC
        LIMIT 200`,
      [ticket.id, org.id]
    );
    const r = await inflight.track(
      noticesModule().sendCrewActivityBatch(db, { ticket: ticket, events: events.rows }, noticeDeps(d)),
      'ticket_crew_activity'
    );
    out.crew.sent += (r && Number(r.sent)) || 0;
  }
}

// ── D. digest / waiting reminder ──────────────────────────────────────────
async function loadFireLog(db) {
  try {
    const r = await db.query(`SELECT value FROM app_settings WHERE key = '${LOG_KEY}'`);
    let v = r.rows.length ? r.rows[0].value : null;
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch (_) { v = null; } }
    return (v && typeof v === 'object' && v.fires && typeof v.fires === 'object') ? v : { fires: {} };
  } catch (e) {
    console.warn('[work-order-notify] fire log load failed:', e && e.message);
    return { fires: {} };
  }
}

async function saveFireLog(db, log) {
  try {
    await db.query(
      `INSERT INTO app_settings (key, value) VALUES ('${LOG_KEY}', $1)
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
      [JSON.stringify(log)]
    );
  } catch (e) {
    console.warn('[work-order-notify] fire log save failed:', e && e.message);
  }
}

function pruneFireLog(log, nowMs) {
  const fires = log.fires || {};
  Object.keys(fires).forEach(function (k) {
    const t = Number(fires[k]);
    if (!t || t < nowMs - LOG_KEEP_MS) delete fires[k];
  });
  log.fires = fires;
  return log;
}

async function deliver(d, u, key, message, org, senderOrg) {
  let reached = false;
  if (emailOn(u, key)) {
    try {
      const r = await d.sendEmail({
        to: u.email,
        subject: message.subject,
        html: message.html,
        text: message.text,
        tag: key,
        organizationId: org.id,
        senderOrg: senderOrg,
        // A rollup has no human author to reply to.
        replyTo: false,
      });
      if (r && r.ok) reached = true;
    } catch (e) {
      console.warn('[work-order-notify] email failed (' + key + '):', e && e.message);
    }
  }
  if (message.push && pushOn(u, key)) {
    try {
      const p = await d.sendPush(Number(u.id), key, message.push, prefsOf(u));
      if (p && p.sent) reached = true;
    } catch (e) {
      console.warn('[work-order-notify] push failed (' + key + '):', e && e.message);
    }
  }
  return reached;
}

function inMorningWindow(zone, now) {
  const wd = tz.dayOfWeekInTz(zone, now);
  const hour = tz.hourInTz(zone, now);
  return wd >= 1 && wd <= 5 && hour >= 7 && hour < 12;
}

async function digestForOrg(d, org, out, ctx) {
  const db = d.db;
  const users = await db.query(
    'SELECT id, timezone FROM users WHERE organization_id = $1 AND active = TRUE ORDER BY id ASC',
    [org.id]
  );
  const due = [];
  users.rows.forEach(function (u) {
    const zone = tz.resolveTz(u.timezone, org.timezone);
    if (!inMorningWindow(zone, ctx.now)) return;
    const fireKey = 'digest|' + u.id + '|' + tz.localDateInTz(zone, ctx.now);
    if (ctx.log.fires[fireKey]) return;
    due.push({ id: Number(u.id), zone: zone, fireKey: fireKey });
  });
  if (!due.length) return false;

  const text = textModule();
  const attention = await attentionModule().attentionForOrg(db, {
    org: org, now: ctx.now, deps: { hasCapability: d.hasCapability, openFlags: d.openFlags },
    userIds: due.map(function (x) { return x.id; }),
  });
  const overDays = text.reminderBusinessDays(org.settings);
  let senderOrg = null;
  let dirty = false;
  for (const person of due) {
    out.digest.users++;
    const entry = attention.get(person.id);
    if (!ctx.dry) { ctx.log.fires[person.fireKey] = ctx.now.getTime(); dirty = true; }
    if (!entry) { out.digest.skipped++; continue; }
    const u = entry.user;
    const digestOn = emailOn(u, DIGEST_KEY) || pushOn(u, DIGEST_KEY);
    const waitingOn = emailOn(u, WAITING_KEY) || pushOn(u, WAITING_KEY);
    let key = null;
    let message = null;
    if (digestOn) {
      key = DIGEST_KEY;
      message = text.digestMessage({ recipient: u, sections: entry.sections, overDays: overDays, zone: org.timezone });
    } else if (waitingOn && entry.overBusinessDays.length) {
      key = WAITING_KEY;
      message = text.waitingReminderMessage({ recipient: u, items: entry.overBusinessDays, overDays: overDays });
    }
    if (!message) { out.digest.skipped++; continue; }
    if (ctx.dry) {
      // A dry run sends nothing, so it cannot know whether a digest would
      // reach a channel: it counts the branch it chose, and the delivery
      // fallback below is deliberately not guessed at here.
      if (key === DIGEST_KEY) out.digest.digests++; else out.digest.reminders++;
      continue;
    }
    if (!senderOrg) {
      const name = await require('./email-sender').orgNameFor(db, org.id);
      senderOrg = name ? { id: org.id, name: name } : { id: org.id };
    }
    const reached = await inflight.track(deliver(d, u, key, message, org, senderOrg), key);
    if (reached) {
      if (key === DIGEST_KEY) out.digest.digests++; else out.digest.reminders++;
      continue;
    }
    // The digest reached NOBODY: its email is off and its push found no
    // device (the pref catalog's "they are in the digest instead" only holds
    // when the digest is actually delivered). The standalone reminder is what
    // this person left on, so fall through to it in the same pass — the fire
    // key for the day is already written, and nothing retries them. Never a
    // double send: a digest that reached any channel returned above.
    if (key === DIGEST_KEY && waitingOn && entry.overBusinessDays.length) {
      const fallback = text.waitingReminderMessage({ recipient: u, items: entry.overBusinessDays, overDays: overDays });
      const alsoReached = await inflight.track(deliver(d, u, WAITING_KEY, fallback, org, senderOrg), WAITING_KEY);
      if (alsoReached) { out.digest.reminders++; continue; }
    }
    out.digest.skipped++;
  }
  return dirty;
}

function emptyResult(dry) {
  return {
    dry: !!dry,
    approvals: { released: 0, candidates: 0, retried: 0, gave_up: 0 },
    crew: { candidates: 0, batches: 0, sent: 0 },
    digest: { users: 0, digests: 0, reminders: 0, skipped: 0 },
  };
}

async function runOnce(opts) {
  const o = opts || {};
  const dry = !!o.dry;
  const out = emptyResult(dry);
  if (inflight.isClosing()) { out.skipped = 'closing'; return out; }
  let d;
  try {
    d = resolveDeps(o.deps);
  } catch (e) {
    console.warn('[work-order-notify] no database:', e && e.message);
    out.error = 'no_database';
    return out;
  }
  const nowParsed = o.now == null ? null : new Date(o.now instanceof Date ? o.now.getTime() : o.now);
  const now = nowParsed && !isNaN(nowParsed.getTime()) ? nowParsed : new Date();

  let orgs = [];
  try {
    const r = await d.db.query('SELECT id, name, timezone, settings FROM organizations WHERE archived_at IS NULL ORDER BY id ASC');
    orgs = r.rows;
  } catch (e) {
    console.warn('[work-order-notify] organization read failed:', e && e.message);
    out.error = 'organizations';
    return out;
  }

  // A. approval retries
  for (const org of orgs) {
    if (inflight.isClosing()) break;
    try {
      await releaseStaleClaims(d.db, org, out, dry);
      await retryDueApprovals(d, org, out, dry);
    } catch (e) {
      console.warn('[work-order-notify] approvals failed for org ' + org.id + ':', e && e.message);
    }
  }

  // C. crew activity
  for (const org of orgs) {
    if (inflight.isClosing()) break;
    try {
      await crewBatches(d, org, out, dry);
    } catch (e) {
      console.warn('[work-order-notify] crew batch failed for org ' + org.id + ':', e && e.message);
    }
  }

  // D. digest / waiting reminder
  let log = null;
  try {
    log = pruneFireLog(await loadFireLog(d.db), now.getTime());
    for (const org of orgs) {
      if (inflight.isClosing()) break;
      let dirty = false;
      try {
        dirty = await digestForOrg(d, org, out, { now: now, log: log, dry: dry });
      } catch (e) {
        console.warn('[work-order-notify] digest failed for org ' + org.id + ':', e && e.message);
      }
      if (dirty && !dry) await saveFireLog(d.db, log);
    }
  } catch (e) {
    console.warn('[work-order-notify] digest step failed:', e && e.message);
  }

  console.log('[work-order-notify] tick — approvals(released=' + out.approvals.released +
    ' cand=' + out.approvals.candidates + ' retried=' + out.approvals.retried + ' gave_up=' + out.approvals.gave_up +
    ') crew(cand=' + out.crew.candidates + ' batches=' + out.crew.batches + ' sent=' + out.crew.sent +
    ') digest(users=' + out.digest.users + ' digests=' + out.digest.digests + ' reminders=' + out.digest.reminders +
    ' skipped=' + out.digest.skipped + ') dry=' + dry);
  return out;
}

// ── scheduling ────────────────────────────────────────────────────────────
let started = false;
let running = false;
let firstTimer = null;
let tickTimer = null;

// One scheduled tick: skipped while closing or while the last one still runs.
// The timers call it with no options; a test passes runOnce's {deps}.
function tick(opts) {
  if (inflight.isClosing() || running) return Promise.resolve(null);
  running = true;
  return inflight.track(runOnce(opts || {}), 'work_order_notify_tick')
    .then(function (r) { running = false; return r; }, function () { running = false; return null; });
}

function start() {
  if (started) return;
  started = true;
  firstTimer = setTimeout(function () {
    firstTimer = null;
    tick();
  }, FIRST_RUN_DELAY_MS);
  if (firstTimer.unref) firstTimer.unref();
  tickTimer = setInterval(function () { tick(); }, TICK_MS);
  if (tickTimer.unref) tickTimer.unref();
  console.log('[work-order-notify] armed; tick every ' + Math.round(TICK_MS / 60000) + ' min');
}

function stop() {
  if (firstTimer) { clearTimeout(firstTimer); firstTimer = null; }
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  started = false;
}

module.exports = { start, stop, runOnce, tick, TICK_MS, FIRST_RUN_DELAY_MS, LOG_KEY };
