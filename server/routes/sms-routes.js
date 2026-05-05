// SMS scheduling agent — inbound webhook + intent matcher.
//
// Twilio POSTs every inbound text to /api/sms/inbound as
// application/x-www-form-urlencoded. We:
//   1. Validate the X-Twilio-Signature so randos can't spam the bot.
//   2. Look up the user by phone_number (E.164).
//   3. Match the body against a small command vocabulary.
//   4. Reply with TwiML so Twilio relays the message back without us
//      having to make a second outbound API call.
//   5. Log inbound + outbound to sms_log for the audit trail.
//
// Command vocabulary (case-insensitive, leading/trailing whitespace
// trimmed). Anything not matching gets a HELP reply listing the
// commands — so workers always have a path forward instead of
// guessing.
//
//   today             → today's schedule for this user
//   tomorrow          → tomorrow's schedule
//   next              → the next scheduled job (today's first remaining or tomorrow's first)
//   week              → next 7 days summary
//   address [n]       → address of today's job N (default 1 — "first job today")
//   help              → command list
//
// Reply length budget: 160 chars per segment. Twilio splits longer
// messages but charges per segment, so we keep replies tight.

const express = require('express');
const { pool } = require('../db');
const sms = require('../sms');

const router = express.Router();

// Parse the urlencoded body Twilio sends. Mounted on this router
// (not globally) so the rest of the app keeps using express.json().
router.use(express.urlencoded({ extended: false }));

console.log('[sms-routes] mounted at /api/sms (Twilio inbound webhook)');

// ──────────────────────────────────────────────────────────────────
// Schedule lookup helpers
// ──────────────────────────────────────────────────────────────────

// Format a schedule_entries row + its job into a one-liner suited to
// SMS. Example: "7:30a · Wimbledon Greens — Bldg 4 demo".
// Times aren't on schedule_entries today (it's a date-level model);
// we omit them rather than fabricate. If the model gains a time
// column later, the formatter picks it up here.
function formatEntryShort(entry, job) {
  const title = (job && (job.title || job.name)) || ('Job ' + (entry.job_id || ''));
  const note = entry.notes ? ' — ' + String(entry.notes).slice(0, 60) : '';
  return title + note;
}

// Pull entries for a user on a given YYYY-MM-DD. Crew is a JSONB
// array of user ids; the entry counts when the user is in it.
async function entriesForUserOnDate(userId, dateIso) {
  const sql =
    "SELECT s.id, s.job_id, s.notes, s.status, s.crew, " +
    "       to_char(s.start_date, 'YYYY-MM-DD') AS start_date, s.days, " +
    "       j.data AS job_data " +
    'FROM schedule_entries s ' +
    'LEFT JOIN jobs j ON j.id = s.job_id ' +
    'WHERE $1 BETWEEN s.start_date AND (s.start_date + (s.days - 1) * INTERVAL \'1 day\') ' +
    "  AND s.crew @> $2::jsonb " +
    'ORDER BY s.start_date ASC, s.created_at ASC';
  const { rows } = await pool.query(sql, [dateIso, JSON.stringify([userId])]);
  return rows.map(function(r) {
    return {
      id: r.id,
      jobId: r.job_id,
      notes: r.notes,
      status: r.status,
      job: r.job_data || {}
    };
  });
}

function isoToday() {
  const d = new Date();
  // Use server local date, not UTC — schedule entries are FL local.
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

function isoOffsetDays(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

function shortDate(iso) {
  // "2026-05-05" → "Tue 5/5"
  try {
    const d = new Date(iso + 'T12:00:00');
    const day = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()];
    return day + ' ' + (d.getMonth() + 1) + '/' + d.getDate();
  } catch (e) { return iso; }
}

// ──────────────────────────────────────────────────────────────────
// Reply builders
// ──────────────────────────────────────────────────────────────────

const HELP_TEXT =
  'AGX commands:\n' +
  'TODAY · TOMORROW · NEXT\n' +
  'WEEK · ADDRESS [n]\n' +
  'HELP';

function replyTodayOrTomorrow(entries, dateIso) {
  if (!entries.length) {
    return 'AGX ' + shortDate(dateIso) + ': nothing scheduled. Reply WEEK for the next 7 days.';
  }
  const head = 'AGX ' + shortDate(dateIso) + ':\n';
  const lines = entries.map(function(e, i) {
    return (i + 1) + '. ' + formatEntryShort(e, e.job);
  });
  return head + lines.join('\n');
}

function replyNext(todayEntries, tomorrowEntries) {
  // "Next" = today's next non-done entry, or the first tomorrow entry
  // if today's all done / empty.
  const todayPending = todayEntries.filter(function(e) { return e.status !== 'done'; });
  if (todayPending.length) {
    const e = todayPending[0];
    const addr = (e.job && e.job.address) ? '\n' + e.job.address : '';
    return 'Next today: ' + formatEntryShort(e, e.job) + addr;
  }
  if (tomorrowEntries.length) {
    const e = tomorrowEntries[0];
    const addr = (e.job && e.job.address) ? '\n' + e.job.address : '';
    return 'Tomorrow: ' + formatEntryShort(e, e.job) + addr;
  }
  return 'Nothing scheduled today or tomorrow. Reply WEEK for the next 7 days.';
}

async function replyWeek(userId) {
  // Days 0..6 inclusive. Skip empty days; if all empty, say so.
  const lines = [];
  for (let i = 0; i < 7; i++) {
    const iso = isoOffsetDays(i);
    const day = await entriesForUserOnDate(userId, iso);
    if (!day.length) continue;
    const head = shortDate(iso);
    const titles = day.map(function(e) { return (e.job && (e.job.title || e.job.name)) || e.jobId; });
    lines.push(head + ': ' + titles.join(', '));
  }
  if (!lines.length) return 'AGX: nothing on your schedule for the next 7 days.';
  return 'AGX 7-day:\n' + lines.join('\n');
}

function replyAddress(todayEntries, n) {
  if (!todayEntries.length) {
    return 'No job today. Reply NEXT for tomorrow.';
  }
  const idx = (n && n > 0) ? (n - 1) : 0;
  const e = todayEntries[idx];
  if (!e) return 'Only ' + todayEntries.length + ' job(s) today. Try ADDRESS 1..' + todayEntries.length + '.';
  const title = (e.job && (e.job.title || e.job.name)) || e.jobId;
  const addr = (e.job && e.job.address) || '(no address on file)';
  return title + '\n' + addr;
}

// ──────────────────────────────────────────────────────────────────
// Intent matcher
// ──────────────────────────────────────────────────────────────────

function parseIntent(rawBody) {
  const body = String(rawBody || '').trim().toLowerCase();
  if (!body) return { intent: 'help' };
  if (/^h(elp)?$|^\?$/.test(body))                 return { intent: 'help' };
  if (/^today$|^t$|^schedule$/.test(body))         return { intent: 'today' };
  if (/^tomor+ow$|^tom$|^tmrw$/.test(body))        return { intent: 'tomorrow' };
  if (/^next$|^n$/.test(body))                     return { intent: 'next' };
  if (/^week$|^w$|^7\s*days?$/.test(body))         return { intent: 'week' };
  // ADDRESS or ADDR optionally followed by a number ("address 2")
  const m = body.match(/^addr(ess)?\s*(\d+)?$/);
  if (m) return { intent: 'address', n: m[2] ? parseInt(m[2], 10) : 1 };
  return { intent: 'unknown' };
}

// ──────────────────────────────────────────────────────────────────
// TwiML responder
// ──────────────────────────────────────────────────────────────────

function twimlReply(text) {
  // Plain TwiML — Twilio relays this body back to the texter.
  // Escape XML metacharacters in the message body so an apostrophe
  // or ampersand can't break the response.
  const escaped = String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Response><Message>' + escaped + '</Message></Response>';
}

// ──────────────────────────────────────────────────────────────────
// POST /api/sms/inbound
// ──────────────────────────────────────────────────────────────────

router.post('/inbound', async function(req, res) {
  const fromNumber = (req.body && req.body.From) || '';
  const toNumber   = (req.body && req.body.To)   || '';
  const body       = (req.body && req.body.Body) || '';

  // Reconstruct the full URL Twilio called us with for signature
  // validation. Behind Railway's proxy, x-forwarded-proto / host
  // give us the public URL the user dialed.
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const host  = req.headers['x-forwarded-host']  || req.headers.host;
  const fullUrl = proto + '://' + host + req.originalUrl;
  const signature = req.headers['x-twilio-signature'] || '';

  if (!sms.validateInboundSignature({ url: fullUrl, params: req.body, signature: signature })) {
    console.warn('[sms] inbound signature failed from=' + fromNumber);
    return res.status(403).type('text/xml').send(twimlReply('Auth failed.'));
  }

  // Look up user. Unknown numbers still get a polite reply (no
  // confirmation that the number is unrecognized — we don't want to
  // leak whether a given phone is on file).
  let userId = null;
  let userName = '';
  try {
    const { rows } = await pool.query(
      'SELECT id, name FROM users WHERE phone_number = $1 AND active = TRUE LIMIT 1',
      [fromNumber]
    );
    if (rows.length) { userId = rows[0].id; userName = rows[0].name || ''; }
  } catch (e) {
    console.error('[sms] user lookup failed:', e.message);
  }

  // Log inbound. Fire and forget.
  pool.query(
    'INSERT INTO sms_log (direction, from_number, to_number, body, user_id, intent) VALUES ($1,$2,$3,$4,$5,$6)',
    ['in', fromNumber, toNumber, body, userId, null]
  ).catch(function(e) { console.warn('[sms] audit log write failed:', e.message); });

  // Build response.
  let replyText;
  let intent = 'unknown';
  try {
    if (!userId) {
      replyText = 'AGX: number not on file. Ask the office to add your phone number to your account.';
      intent = 'unknown_sender';
    } else {
      const parsed = parseIntent(body);
      intent = parsed.intent;
      if (intent === 'help' || intent === 'unknown') {
        replyText = HELP_TEXT;
        intent = 'help';
      } else if (intent === 'today') {
        const entries = await entriesForUserOnDate(userId, isoToday());
        replyText = replyTodayOrTomorrow(entries, isoToday());
      } else if (intent === 'tomorrow') {
        const dateIso = isoOffsetDays(1);
        const entries = await entriesForUserOnDate(userId, dateIso);
        replyText = replyTodayOrTomorrow(entries, dateIso);
      } else if (intent === 'next') {
        const today = await entriesForUserOnDate(userId, isoToday());
        const tomorrow = await entriesForUserOnDate(userId, isoOffsetDays(1));
        replyText = replyNext(today, tomorrow);
      } else if (intent === 'week') {
        replyText = await replyWeek(userId);
      } else if (intent === 'address') {
        const entries = await entriesForUserOnDate(userId, isoToday());
        replyText = replyAddress(entries, parsed.n);
      } else {
        replyText = HELP_TEXT;
      }
    }
  } catch (e) {
    console.error('[sms] reply build failed:', e);
    replyText = 'AGX: trouble looking that up. Try HELP for the command list.';
    intent = 'error';
  }

  // Log outbound (the TwiML reply Twilio is about to relay).
  pool.query(
    'INSERT INTO sms_log (direction, from_number, to_number, body, user_id, intent) VALUES ($1,$2,$3,$4,$5,$6)',
    ['out', toNumber, fromNumber, replyText, userId, intent]
  ).catch(function(e) { console.warn('[sms] audit log write failed:', e.message); });

  res.type('text/xml').send(twimlReply(replyText));
});

module.exports = router;
