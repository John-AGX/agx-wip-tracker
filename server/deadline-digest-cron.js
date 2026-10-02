'use strict';

/* THE THINGS THAT BECAME TRUE BECAUSE TIME PASSED.
 *
 * The two notification slices before this one (services/money-notices.js,
 * services/comment-notices.js) both fire from an Express route handler, because
 * both answer "somebody did something". This one answers the other half: a lead
 * you meant to ring today, an invoice that went past due overnight, a bill whose
 * payment date arrived, an RFI nobody answered. Nobody clicks any of those into
 * existence. The calendar does.
 *
 *   lead_followup       leads.next_followup_at          → the salesperson
 *   invoice_past_due    invoices.due_date               → the invoice's owner
 *   bill_payment_due    job_vendor_bills.due_date       → whoever entered it,
 *                                                         else the job's PM
 *   workflow_overdue    job_workflow_items.due_date     → the responsible
 *                                                         person, else whoever
 *                                                         raised it
 *
 * ━━ ONE EMAIL PER PERSON PER DAY. THIS IS THE WHOLE SAFETY ARGUMENT ━━
 *
 * "Past due" is a STANDING CONDITION, not an event. It has a near edge and no
 * far edge: an invoice that is never going to be paid is past due again
 * tomorrow, and the day after, for years. Every per-row notifier in this repo
 * gets away with firing daily only because its predicate is a WINDOW the record
 * eventually leaves — cert-expiry-cron.js scans a reminder_days band around
 * today, on both sides. `due_date < CURRENT_DATE` is one-sided. A per-row sender
 * on that predicate is one email per overdue record per day, forever.
 *
 * And there is NOTHING in this repo that would catch it. There is no
 * per-recipient throttle in email.js or email-sender.js; no cron caps its own
 * sends; money-notices' BURST_CAP is an in-process Map keyed on three coarse
 * strings, empty after every deploy. Four per-row scanners would have put four
 * separate emails in one person's inbox in the same minute on day one, and a
 * hundred on the day somebody imports a spreadsheet of past follow-up dates.
 *
 * So this is a DIGEST: one message per person per local day, four sections,
 * each section capped. The cost does not scale with the size of the backlog —
 * which is also why there is deliberately NO first-run date floor and NO
 * per-row "already notified" claim column, and that is a departure from the
 * nearest precedent worth stating:
 *
 *   work-order-notify-cron.js bounds its scan to the last 14 days so that a
 *   deploy "does not re-announce old history". That is exactly right for an
 *   EVENT — a work order that reached Work complete three months ago is news to
 *   nobody. It is exactly wrong for a standing condition. An invoice that went
 *   past due in March is not old history; it is still past due this morning,
 *   and a digest that hid it would be lying by omission. The thing a floor is
 *   there to prevent — volume — is already prevented by the digest and the
 *   per-section cap, so buying it a second time with silence is a bad trade.
 *
 * The closest precedent is therefore reminders-cron.js's task-due digest, which
 * re-lists every overdue task every morning and is correct to.
 *
 * ━━ TENANCY: THE RECORD'S ORG MUST EQUAL THE RECIPIENT'S ━━
 *
 * A cron has no req.user, so the usual `organization_id = $1` has no $1. The
 * other crons loop one org at a time. This one does not, and deliberately: the
 * predicate is `<record>.organization_id = u.organization_id` — the record and
 * the person it would be mailed to must be in the SAME tenant, asserted on the
 * join itself (the shape reminders-cron.js uses for tasks).
 *
 * That is stronger than a per-org loop, not weaker. A per-org loop written with
 * this repo's usual `(organization_id = $1 OR organization_id IS NULL)` arm
 * would match an org-less record in EVERY tenant's pass and mail it to all of
 * them. Here, an org-less record simply never matches — NULL = NULL is not true
 * in SQL — so it is skipped rather than broadcast. It also adds NO new
 * `organization_id IS NULL` arm to the count docs/TENANCY-GRADUATION.md item 9
 * is trying to drive to zero.
 *
 * Bills are the one exception, and for the documented reason:
 * job_vendor_bills.organization_id is nullable while its job_id is NOT NULL, so
 * a bill is reached through its job ("payable by whichever tenant owns the
 * job"), exactly as services/money-notices.js reaches it.
 *
 * ━━ THE CLOCK IS THE RECIPIENT'S, NOT THE SERVER'S ━━
 *
 * Every query over-fetches to CURRENT_DATE + 1 day and the per-person filter
 * happens in JS against tz.localDateInTz. Comparing to the server's own date
 * would be wrong for the same reason server/timezone.js names in its own
 * header: this server runs in UTC, so from 8pm Eastern onward "today" is
 * already tomorrow, and a Florida contractor would be told an invoice is a day
 * late before it is.
 *
 * DATE columns are read as 'YYYY-MM-DD' strings straight from to_char, never
 * through toISOString on a Date — node-postgres hands a DATE back as LOCAL
 * midnight, and toISOString then reads the UTC day off that instant. The slip
 * is EAST of UTC: at UTC+2 local midnight on the 12th is 22:00Z on the 11th, so
 * toISOString says the eleventh. (An earlier draft of this comment said west,
 * which is backwards — at UTC-4 the two agree.) Latent on Railway, which runs
 * UTC; real on a dev machine east of Greenwich. cert-expiry-cron.js carried
 * exactly that bug inside its dedupe key until 1.88.
 *
 * ━━ THE SYNC ━━
 *
 * Unlike the money notices, no route boundary is needed: a cron cannot be
 * triggered by a write at all. But the Buildertrend sync DOES rewrite
 * job_vendor_bills.due_date in bulk on an unattended 30-minute tick
 * (services/clickr/sync-apply.js), so a sync can make hundreds of bills qualify
 * at once. The digest is what makes that survivable: hundreds of newly-qualified
 * bills are still one email per person, with the section capped.
 */

const { pool } = require('./db');
const tz = require('./timezone');
const delivery = require('./services/notice-delivery');
const text = require('./services/notice-text');
const openDoor = require('./services/workflow-open-door');

// One catalog key per section (server/notify-events.js). Four keys rather than
// one digest key because the four are genuinely different jobs — a salesperson
// wants follow-ups and does not want accounts payable — and a key the user can
// switch off must switch off something they recognise.
const KEYS = Object.freeze({
  leadFollowup: 'lead_followup',
  invoicePastDue: 'invoice_past_due',
  billPaymentDue: 'bill_payment_due',
  workflowOverdue: 'workflow_overdue',
});

// Rows shown per section before the message says "and N more". A digest is a
// nudge, not a report: past this many the list stops being readable and the
// link does the work.
const SECTION_CAP = 8;

// The recipient's local window. Same shape as the task digest: the first tick
// at or after 07:00 local sends, and nothing sends after 22:00 so a late
// deploy does not wake anybody.
const WINDOW_START_HOUR = 7;
const WINDOW_END_HOUR = 22;

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const TICK_MS = 60 * 60 * 1000;         // hourly; the window is 15 hours wide
const FIRST_RUN_DELAY_MS = 60 * 1000;
const LEDGER_KEY = 'deadline_digest_log';

/* The tick lock lives in services/cron-tick-lock.js, because cert-expiry-cron
 * needs exactly the same thing and a second copy of a subtle lock is how the
 * two would drift. Its header has the whole argument: every cron here dedupes
 * through one JSONB row rewritten whole, and whether this app runs one replica
 * cannot be read from this repository at all. */
const tickLock = require('./services/cron-tick-lock');
const TICK_LOCK_KEY = tickLock.KEYS.deadlineDigest;

/* A lead that has been won or lost is not waiting for a call. This set exists
 * three times on the client (js/leads.js, js/app.js, js/entities-map.js) and
 * nowhere on the server, because nothing server-side had ever needed to know —
 * leads.status carries no CHECK constraint either. This is the first server
 * reader, so it is stated once, here, rather than becoming a fourth copy. */
const TERMINAL_LEAD_STATUSES = Object.freeze(['sold', 'lost', 'no_opportunity']);

// ── the ledger ────────────────────────────────────────────────────────────
// Same shape and the same caveats as every other cron's: a JSONB blob in
// app_settings, pruned at 60 days. It holds ONE key per person per local day,
// not one per record, so it stays small no matter how big the backlog is.
async function loadLedger() {
  try {
    const r = await pool.query('SELECT value FROM app_settings WHERE key = $1', [LEDGER_KEY]);
    return (r.rows.length && r.rows[0].value) || { fires: {} };
  } catch (e) {
    console.warn('[deadlines] ledger load failed:', e && e.message);
    return { fires: {} };
  }
}

async function saveLedger(ledger) {
  try {
    await pool.query(
      'INSERT INTO app_settings (key, value) VALUES ($1, $2)'
      + ' ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()',
      [LEDGER_KEY, JSON.stringify(ledger)]
    );
  } catch (e) {
    console.warn('[deadlines] ledger save failed:', e && e.message);
  }
}

function pruneLedger(ledger, nowMs) {
  const cutoff = nowMs - 60 * ONE_DAY_MS;
  const fires = ledger.fires || {};
  Object.keys(fires).forEach(function (k) {
    const t = Number(fires[k]);
    if (!t || t < cutoff) delete fires[k];
  });
  ledger.fires = fires;
  return ledger;
}

// ── the four scans ────────────────────────────────────────────────────────
// Every one of them returns the same row shape: the recipient's identity and
// timezone inputs, plus the item. The org term is on the join, never a
// parameter — see the header.

// The columns every scan needs about the person it would mail.
const WHO = [
  'u.id AS uid, u.email, u.name, u.notification_prefs,',
  'u.timezone AS user_tz, o.timezone AS org_tz, o.id AS org_id, o.name AS org_name',
].join(' ');

const REACHABLE = "u.active = TRUE AND u.email IS NOT NULL AND u.email <> ''";

// Over-fetch by one day in EVERY scan: the recipient's local date decides, and
// it can be a day behind the server's.
const HORIZON = "<= CURRENT_DATE + INTERVAL '1 day'";

function scanLeads() {
  return pool.query(
    'SELECT ' + WHO + ','
    + " l.id, l.title AS label, to_char(l.next_followup_at, 'YYYY-MM-DD') AS due_iso"
    + ' FROM leads l'
    + ' JOIN users u ON u.id = l.salesperson_id'
    + ' LEFT JOIN organizations o ON o.id = u.organization_id'
    + ' WHERE l.organization_id = u.organization_id'
    + ' AND l.next_followup_at IS NOT NULL'
    + ' AND l.next_followup_at ' + HORIZON
    + ' AND NOT (l.status = ANY($1::text[]))'
    + ' AND ' + REACHABLE
    + ' ORDER BY u.id, l.next_followup_at ASC',
    [TERMINAL_LEAD_STATUSES.slice()]
  );
}

function scanInvoices() {
  return pool.query(
    'SELECT ' + WHO + ','
    + ' i.id, COALESCE(NULLIF(i.invoice_number, $1), i.id) AS label,'
    + ' (i.total - i.amount_paid) AS amount,'
    + " to_char(i.due_date, 'YYYY-MM-DD') AS due_iso"
    + ' FROM invoices i'
    + ' JOIN users u ON u.id = i.owner_id'
    + ' LEFT JOIN organizations o ON o.id = u.organization_id'
    + ' WHERE i.organization_id = u.organization_id'
    // The same two statuses the AR aging rollup calls outstanding
    // (routes/invoice-routes.js), so the email and the screen agree. NOT its
    // `due_date || issue_date` fallback: an invoice with terms and no due date
    // has no deadline, and inventing one would mail every pay-app invoice.
    + " AND i.status IN ('sent', 'partial')"
    + ' AND i.due_date IS NOT NULL'
    + ' AND i.due_date ' + HORIZON
    + ' AND (i.total - i.amount_paid) > 0.005'
    + ' AND ' + REACHABLE
    + ' ORDER BY u.id, i.due_date ASC',
    ['']
  );
}

function scanBills() {
  return pool.query(
    'SELECT ' + WHO + ','
    + ' b.id, COALESCE(NULLIF(b.bill_number, $1), b.id) AS label, b.amount,'
    + " to_char(b.due_date, 'YYYY-MM-DD') AS due_iso"
    + ' FROM job_vendor_bills b'
    + ' JOIN jobs j ON j.id = b.job_id'
    // Whoever entered it; failing that the job's PM, which is the one person
    // column in this chain that cannot be NULL (jobs.owner_id is NOT NULL).
    + ' JOIN users u ON u.id = COALESCE(b.owner_id, j.owner_id)'
    + ' LEFT JOIN organizations o ON o.id = u.organization_id'
    // Through the JOB, because job_vendor_bills.organization_id is nullable
    // while job_id is NOT NULL — the anchor services/money-notices.js uses.
    + ' WHERE j.organization_id = u.organization_id'
    + " AND b.status IN ('open', 'approved')"
    // No bill_date fallback. The AP aging rollup has one, which is evidence
    // that bill due dates are often absent — and a vendor's invoice date is
    // not a payment deadline, least of all across a Buildertrend-synced
    // population.
    + ' AND b.due_date IS NOT NULL'
    + ' AND b.due_date ' + HORIZON
    + ' AND ' + REACHABLE
    + ' ORDER BY u.id, b.due_date ASC',
    ['']
  );
}

function scanWorkflowItems() {
  return pool.query(
    'SELECT ' + WHO + ','
    + " w.id, w.type, COALESCE(NULLIF(w.number, $1) || ' — ', '') || w.subject AS label,"
    + " to_char(w.due_date, 'YYYY-MM-DD') AS due_iso"
    + ' FROM job_workflow_items w'
    + ' JOIN users u ON u.id = COALESCE(w.responsible_user_id, w.created_by_user_id)'
    + ' LEFT JOIN organizations o ON o.id = u.organization_id'
    + ' WHERE w.organization_id = u.organization_id'
    + ' AND w.archived_at IS NULL'
    + ' AND w.closed_at IS NULL'
    // OPEN IS A STATUS QUESTION. `closed_at IS NULL` alone reports an ANSWERED
    // RFI and a SENT transmittal as still needing action, forever — see
    // services/workflow-open-door.js. The closed_at term stays because it is
    // what keeps idx_jwi_due_open applicable.
    + ' AND ' + openDoor.openSql('w')
    + ' AND w.due_date IS NOT NULL'
    + ' AND w.due_date ' + HORIZON
    + ' AND ' + REACHABLE
    + ' ORDER BY u.id, w.due_date ASC',
    ['']
  );
}

// ── per-person assembly ───────────────────────────────────────────────────

const SECTIONS = [
  { key: KEYS.leadFollowup, prop: 'leads', heading: 'Leads to follow up', scan: scanLeads, link: '/estimates/leads' },
  { key: KEYS.invoicePastDue, prop: 'invoices', heading: 'Invoices owed to you', scan: scanInvoices, link: '/invoices' },
  { key: KEYS.billPaymentDue, prop: 'bills', heading: 'Bills to pay', scan: scanBills, link: '/jobs' },
  { key: KEYS.workflowOverdue, prop: 'workflow', heading: 'RFIs and submittals waiting', scan: scanWorkflowItems, link: '/jobs' },
];

/* Run all four scans and fold them into one record per person. */
async function gather() {
  const byUser = new Map();
  for (const section of SECTIONS) {
    let rows = [];
    try {
      rows = (await section.scan()).rows;
    } catch (e) {
      // One scan failing must not cost the other three. The person still gets
      // the sections that worked, and the log says which did not.
      console.warn('[deadlines] scan failed (' + section.key + '):', e && e.message);
      continue;
    }
    for (const row of rows) {
      const uid = Number(row.uid);
      if (!uid) continue;
      let who = byUser.get(uid);
      if (!who) {
        who = {
          uid: uid,
          email: row.email,
          name: row.name,
          // NAMED notification_prefs, not prefs: services/notice-delivery.js
          // reads this field off the object by that name (prefsOf), so a record
          // spelling it differently silently ignored every switch in My Account
          // and mailed people who had turned the section off.
          notification_prefs: row.notification_prefs || {},
          zone: tz.resolveTz(row.user_tz, row.org_tz),
          orgId: row.org_id,
          orgName: row.org_name,
        };
        SECTIONS.forEach(function (s) { who[s.prop] = []; });
        byUser.set(uid, who);
      }
      who[section.prop].push(row);
    }
  }
  return byUser;
}

function daysLate(dueIso, localToday) {
  const a = text.ymdToUtcMs(dueIso);
  const b = text.ymdToUtcMs(localToday);
  if (a == null || b == null) return 0;
  return Math.round((b - a) / ONE_DAY_MS);
}

function whenLabel(dueIso, localToday) {
  const n = daysLate(dueIso, localToday);
  if (n <= 0) return 'Due today';
  if (n === 1) return '1 day late';
  return n + ' days late';
}

function money(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '';
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/* The sections this person should actually be shown, already filtered to their
 * local today and to the switches they have left on. `gate` is emailOn or
 * pushOn — the same person can have email off and push on for one section and
 * the reverse for another, and each channel is composed from its own list. */
function sectionsFor(who, localToday, gate) {
  const out = [];
  for (const section of SECTIONS) {
    if (!gate(who, section.key)) continue;
    const due = (who[section.prop] || []).filter(function (r) {
      return r.due_iso && r.due_iso <= localToday;
    });
    if (!due.length) continue;
    out.push({ section: section, rows: due });
  }
  return out;
}

function countOf(list) {
  return list.reduce(function (n, s) { return n + s.rows.length; }, 0);
}

// ── the message ───────────────────────────────────────────────────────────

function subjectFor(list, localToday) {
  const n = countOf(list);
  const late = list.reduce(function (acc, s) {
    return acc + s.rows.filter(function (r) { return daysLate(r.due_iso, localToday) > 0; }).length;
  }, 0);
  if (late === n) return text.plural(n, 'thing') + ' past due';
  if (late === 0) return text.plural(n, 'thing') + ' due today';
  return text.plural(n, 'thing') + ' need you — ' + late + ' past due';
}

function rowLine(entry, r, localToday) {
  const when = whenLabel(r.due_iso, localToday);
  const amount = r.amount == null ? '' : money(r.amount);
  return {
    label: text.oneLine(r.label, 120) || r.id,
    meta: [when, amount].filter(Boolean).join(' · '),
  };
}

function buildMessage(who, list, localToday) {
  const base = text.appUrl();
  const subject = subjectFor(list, localToday);

  let bodyHtml = '<p>' + text.escHtml('Hi ' + text.greetingName(who) + ', here is what has a date on it this morning.') + '</p>';
  let bodyText = 'Hi ' + text.greetingName(who) + ', here is what has a date on it this morning.\n';

  for (const entry of list) {
    const shown = entry.rows.slice(0, SECTION_CAP);
    const more = entry.rows.length - shown.length;
    bodyHtml += '<h3 style="margin:22px 0 6px;font-size:13px;text-transform:uppercase;'
      + 'letter-spacing:.4px;color:#6b7280;">'
      + text.escHtml(entry.section.heading) + ' (' + entry.rows.length + ')</h3>';
    bodyHtml += '<table style="border-collapse:collapse;width:100%;font-size:14px;">'
      + shown.map(function (r) {
        const line = rowLine(entry, r, localToday);
        return '<tr><td style="padding:6px 10px 6px 0;border-bottom:1px solid #eef0f3;">'
          + text.escHtml(line.label) + '</td>'
          + '<td style="padding:6px 0;border-bottom:1px solid #eef0f3;color:#6b7280;'
          + 'white-space:nowrap;text-align:right;">' + text.escHtml(line.meta) + '</td></tr>';
      }).join('')
      + '</table>';
    bodyText += '\n' + entry.section.heading + ' (' + entry.rows.length + ')\n'
      + shown.map(function (r) {
        const line = rowLine(entry, r, localToday);
        return '  - ' + line.label + (line.meta ? '  [' + line.meta + ']' : '');
      }).join('\n') + '\n';
    if (more > 0) {
      // Say what was left out. A silent cap reads as "that is all of them".
      const note = 'and ' + more + ' more';
      bodyHtml += '<p style="margin:6px 0 0;font-size:13px;color:#6b7280;">' + text.escHtml(note) + '</p>';
      bodyText += '  ' + note + '\n';
    }
  }

  const footer = text.footerSentence(
    'You are getting this because these are assigned to you and their date has arrived.'
  );

  return {
    subject: subject,
    html: text.emailShell({
      heading: subject,
      bodyHtml: bodyHtml,
      button: { label: 'Open Project 86', href: base },
      footerHtml: footer.html,
    }),
    text: bodyText + '\nOpen Project 86: ' + base + '\n\n' + footer.text,
  };
}

function pushFor(list, localToday) {
  const n = countOf(list);
  if (!n) return null;
  return {
    title: '📅 ' + subjectFor(list, localToday),
    body: text.oneLine(list.map(function (s) {
      return s.rows.length + ' ' + s.section.heading.toLowerCase();
    }).join(' · '), 200),
    url: text.appUrl() + '/summary',
    // One per person per day on the device, same as the ledger key.
    tag: 'deadlines:' + localToday,
  };
}

// ── orchestration ─────────────────────────────────────────────────────────
//
//   opts.dry   — report what WOULD be sent, per person, with real counts, and
//                send nothing. Unlike cert-expiry-cron's dry mode, which skips
//                the scan entirely and therefore reports zero candidates for
//                every org, this runs the whole pipeline and stops at the send.
//                A scan whose only risk is volume has to be able to show you
//                the volume before you arm it.
//   opts.force — ignore the local-hour window and the per-day ledger.
//   opts.now   — the instant to treat as now (tests; also makes the window
//                reachable without waiting for morning).
async function runOnce(opts) {
  const o = opts || {};
  const dry = !!o.dry;
  const force = !!o.force;
  const now = o.now instanceof Date ? o.now : (o.now ? new Date(o.now) : new Date());
  const nowMs = now.getTime();
  const out = { dry: dry, force: force, people: [], sent: 0, skipped: 0, items: 0 };

  // A dry run takes no lock: it sends nothing and writes nothing, so two of
  // them racing costs nobody anything, and a preview that could be blocked by
  // a live tick would be a preview you cannot trust to run when you ask.
  let release = null;
  if (!dry) {
    release = await tickLock.take(pool, TICK_LOCK_KEY, 'deadlines');
    if (!release) {
      console.log('[deadlines] tick skipped — another replica holds the lock');
      return Object.assign(out, { skippedTick: 'locked' });
    }
  }

  try {
    const ledger = pruneLedger(await loadLedger(), nowMs);
    const fires = ledger.fires;
    let dirty = false;

    const byUser = await gather();
    for (const who of byUser.values()) {
      const localToday = tz.localDateInTz(who.zone, now);
      const emailList = sectionsFor(who, localToday, delivery.emailOn);
      const pushList = sectionsFor(who, localToday, delivery.pushOn);
      if (!emailList.length && !pushList.length) continue;

      const entry = {
        uid: who.uid, zone: who.zone, localDate: localToday,
        email: countOf(emailList), push: countOf(pushList),
      };
      out.items += entry.email;

      const localHour = tz.hourInTz(who.zone, now);
      const inWindow = localHour >= WINDOW_START_HOUR && localHour < WINDOW_END_HOUR;
      const dkey = 'deadlines|' + who.uid + '|' + localToday;
      if (!force && !inWindow) { entry.skipped = 'outside_window'; out.skipped++; out.people.push(entry); continue; }
      if (!force && fires[dkey]) { entry.skipped = 'already_today'; out.skipped++; out.people.push(entry); continue; }
      if (dry) { entry.wouldSend = true; out.sent++; out.people.push(entry); continue; }

      try {
        if (emailList.length) {
          const message = buildMessage(who, emailList, localToday);
          const senderOrg = who.orgName ? { id: who.orgId, name: who.orgName } : { id: who.orgId };
          await require('./email').sendEmail({
            to: who.email,
            subject: message.subject,
            html: message.html,
            text: message.text,
            tag: 'deadline_digest',
            organizationId: who.orgId == null ? undefined : who.orgId,
            senderOrg: who.orgId == null ? undefined : senderOrg,
            // Nobody wrote this, so a reply has nowhere useful to land.
            replyTo: false,
          });
        }
        if (pushList.length) {
          const payload = pushFor(pushList, localToday);
          // The push rides the FIRST section the person still has on, because
          // sendPushForEvent takes one key and every key in pushList already
          // passed pushOn.
          const pushKey = pushList[0].section.key;
          await require('./notify-events')
            .sendPushForEvent(who.uid, pushKey, payload, who.notification_prefs)
            .catch(function () {});
        }
        fires[dkey] = nowMs;
        dirty = true;
        entry.sent = true;
        out.sent++;
      } catch (e) {
        console.warn('[deadlines] send failed for user ' + who.uid + ':', e && e.message);
        entry.error = e && e.message;
      }
      out.people.push(entry);

      // Saved INSIDE the loop, after each person. cert-expiry-cron.js saves its
      // log once after the whole org loop, so an exception anywhere in that
      // loop loses the markers for every org already mailed in that tick and
      // the next tick mails them all again. One extra write per recipient per
      // day is a cheap price for not doing that.
      if (dirty) { await saveLedger(ledger); dirty = false; }
    }

    if (dirty) await saveLedger(ledger);
    if (!dry) {
      console.log('[deadlines] tick — people=' + byUser.size + ' sent=' + out.sent
        + ' skipped=' + out.skipped + ' items=' + out.items);
    }
    return out;
  } catch (e) {
    console.error('[deadlines] scan failed:', e && e.message);
    return Object.assign(out, { error: e && e.message });
  } finally {
    if (release) await release();
  }
}

let _started = false;
function start() {
  if (_started) return;
  _started = true;
  setTimeout(function () {
    runOnce().catch(function (e) { console.warn('[deadlines] warmup error:', e && e.message); });
  }, FIRST_RUN_DELAY_MS);
  setTimeout(function tick() {
    runOnce().catch(function (e) { console.warn('[deadlines] tick error:', e && e.message); });
    setTimeout(tick, TICK_MS);
  }, TICK_MS);
  console.log('[deadlines] digest scanner started (hourly, each recipient\'s local morning)');
}

module.exports = {
  start,
  runOnce,
  TICK_LOCK_KEY,
  KEYS,
  SECTIONS,
  SECTION_CAP,
  TERMINAL_LEAD_STATUSES,
  LEDGER_KEY,
  // exported for tests
  _internal: { gather, sectionsFor, buildMessage, pushFor, subjectFor, whenLabel, daysLate },
};
