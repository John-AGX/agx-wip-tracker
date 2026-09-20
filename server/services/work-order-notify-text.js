'use strict';

// WHAT A WORK-ORDER NOTICE SAYS. Pure: no database, no senders, no clock unless
// one is passed. Requires only ../timezone.
//
// Every office notice about a work order (assignment, a problem a crew flagged,
// the crew-activity batch, the morning digest, the waiting reminder) and the
// one crew email (sent back for more work) is worded here, so the wording is
// pinned in one test file and the senders stay about WHO and WHEN.
//
// NO MONEY, by construction. A builder is handed a ticket row, a site from
// service-ticket-workorder.js workOrderSite ({job_number, name, address}) and
// counts. It reads the ticket's title, dates and priority and the site's number,
// name and address. It never reads a price, cost, total, amount or contract
// field, and never materials, internal notes, the guest log or the takeoff.
//
// TYPED TEXT. Office-typed text (titles, reasons) goes through oneLine before a
// subject, a push body or a plain-text line, and through escHtml before HTML.
// Crew-typed text is a claim from whoever holds the link: a name goes through
// crewName, anything longer (a problem note, a building note) through crewText,
// which also takes out words that read as links.
//
// crewName, oneLine, escHtml, appUrl and ticketLink are the approval notice's
// own (services/service-ticket-notify.js), copied here unchanged so the two
// cannot drift once that module re-exports these.

const tz = require('../timezone');

// Office wording for a flag category (emails, office UI, the change-order
// prefill). The crew page has its own, friendlier labels.
const FLAG_CATEGORY_LABELS = Object.freeze({
  no_access: 'No access',
  extra_damage: 'Extra damage',
  material_short: 'Material short',
  safety: 'Safety',
  other: 'Other',
});

const NOTIFY_FOOTER_TEXT = 'Toggle notifications in My Account → Notifications.';
const NOTIFY_FOOTER_HTML = 'Toggle notifications in <strong>My Account &rarr; Notifications</strong>.';

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

// A word a mail app or a phone would turn into a link. Trailing punctuation is
// ignored ("evil.com," is still a domain), and a scheme counts only with
// something after it, so a note that says "Note:" or "Data:" keeps its word.
// A dot and two or more letters is a domain wherever the letters stop — at the
// end, or before anything that is not a letter or digit ("evil.com's",
// "pay.example.com&ref=1", "evil.com-", "evil.com_x", "evil.com<b>") — because
// mail apps and phone data detectors link the domain and ignore what follows.
// "Bldg.784", "2.5 ft." and "e.g." have no such run and keep their words.
const LINK_SCHEME_RE = /^(?:https?|ftp|mailto|tel|sms|javascript|vbscript|data|file|blob|wss?|intent):./i;
const DOMAIN_RUN_RE = /\.\p{L}{2,}(?![\p{L}\p{N}])/u;
function looksLikeLink(word) {
  const w = String(word || '').replace(/[.,;!?)\]}"'’”]+$/u, '');
  if (!w) return false;
  if (w.indexOf('://') >= 0) return true;
  if (LINK_SCHEME_RE.test(w)) return true;
  if (/^www\./i.test(w)) return true;
  if (/@.*\./.test(w)) return true;
  return DOMAIN_RUN_RE.test(w);
}

// Invisible characters that change nothing a reader sees but split or hide a
// word from the checks above: zero-width space and joiners, soft hyphen, word
// joiner, bidi embeddings, overrides and isolates, variation selectors, BOM.
const INVISIBLE_RE = /[\p{Cf}\p{Default_Ignorable_Code_Point}]+/gu;

// Longer crew-typed text (a problem note, a building note) quoted in an office
// email or push: one line, NFKC, invisible characters removed, every run of
// link-like words replaced by one "[link removed]", cut by code point so no
// character is split.
function crewText(s, max) {
  const limit = Number.isSafeInteger(max) && max > 0 ? max : 500;
  let text = oneLine(s, 5000);
  try { text = text.normalize('NFKC'); } catch (_) { /* keep as typed */ }
  text = text.replace(INVISIBLE_RE, '');
  const out = [];
  oneLine(text, 5000).split(' ').forEach(function (w) {
    if (!w) return;
    if (looksLikeLink(w)) {
      if (out[out.length - 1] !== '[link removed]') out.push('[link removed]');
      return;
    }
    out.push(w);
  });
  return Array.from(out.join(' ')).slice(0, limit).join('').trim();
}

function positiveInt(v) {
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

// Date | 'YYYY-MM-DD HH:MM:SS' (read as UTC, the way the sqlite fixture and
// CAST(... AS TEXT) hand timestamps back) | ISO string | epoch ms -> Date | null.
function asDate(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  if (typeof v === 'number') {
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  const s = String(v).trim();
  let d;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) d = new Date(s + 'T00:00:00Z');
  else if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) d = new Date(s.replace(' ', 'T') + 'Z');
  else d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

const DAY_MS = 86400000;
function ymdToUtcMs(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd || ''));
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

// Monday-to-Friday calendar days in `zone` AFTER the start's local date, up to
// and including today. A Friday 4:55 pm finish is 1 on Monday, 2 on Tuesday
// and 3 on Wednesday; a Saturday finish is 1 on Monday. Holidays are not known.
function businessDaysSince(start, now, zone) {
  const s = asDate(start);
  if (!s) return 0;
  const n = asDate(now) || new Date();
  const z = tz.resolveTz(null, zone);
  const from = ymdToUtcMs(tz.localDateInTz(z, s));
  const to = ymdToUtcMs(tz.localDateInTz(z, n));
  if (from == null || to == null || to <= from) return 0;
  let count = 0;
  let guard = 0;
  for (let t = from + DAY_MS; t <= to && guard < 3700; t += DAY_MS, guard++) {
    const wd = new Date(t).getUTCDay();
    if (wd !== 0 && wd !== 6) count++;
  }
  return count;
}

// organizations.settings.work_orders.approval_reminder_business_days: a whole
// number from 1 to 10, 2 when unset or unreadable.
function reminderBusinessDays(settings) {
  let s = settings;
  if (typeof s === 'string') { try { s = JSON.parse(s); } catch (_) { s = null; } }
  const raw = s && typeof s === 'object' && s.work_orders && typeof s.work_orders === 'object'
    ? s.work_orders.approval_reminder_business_days
    : undefined;
  if (raw == null || raw === '' || typeof raw === 'boolean') return 2;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 2;
  return Math.min(10, Math.max(1, Math.floor(n)));
}

// A DATE column is a calendar day, never shifted into a zone: "Fri Sep 12".
// node-postgres hands a DATE back as local midnight, so a Date is read by its
// local parts; a string by its YYYY-MM-DD prefix.
function calendarDayLabel(v) {
  if (v == null || v === '') return '';
  let ms = null;
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return '';
    ms = Date.UTC(v.getFullYear(), v.getMonth(), v.getDate());
  } else {
    ms = ymdToUtcMs(String(v).trim());
  }
  if (ms == null) return '';
  return tz.formatInTz(new Date(ms), 'UTC', { weekday: 'short', month: 'short', day: 'numeric' }).replace(/,/g, '');
}

// An instant shown as the day it falls on in `zone`: "Thu Sep 18".
function instantDayLabel(v, zone) {
  const d = asDate(v);
  if (!d) return '';
  return tz.formatInTz(d, tz.resolveTz(null, zone), { weekday: 'short', month: 'short', day: 'numeric' }).replace(/,/g, '');
}

function plural(n, one, many) {
  return n + ' ' + (n === 1 ? one : (many || one + 's'));
}

// "M1001 · BH Management Latitude" — the job number and name, or a lead's name.
function jobLineOf(site) {
  const s = site || {};
  return oneLine([s.job_number, s.name].filter(Boolean).join(' · '), 200);
}

function lineFor(item) {
  if (item && item.jobLine != null) return oneLine(item.jobLine, 200);
  return jobLineOf(item && item.site);
}

function titleOf(ticket) {
  return oneLine(ticket && ticket.title, 200) || 'Work order';
}

// The approval email's logo, card and footer, for every other office notice.
//   heading    plain text
//   bodyHtml   already-escaped HTML
//   button     {label, href} | null
//   footerHtml already-escaped HTML
function emailShell(o) {
  const opts = o || {};
  const base = appUrl();
  return '<!doctype html><html><body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;">' +
    '<div style="max-width:560px;margin:24px auto;padding:24px;background:#fff;border-radius:10px;color:#1f2937;line-height:1.5;">' +
      '<div style="margin-bottom:12px;"><img src="' + base + '/images/logo-color.png" alt="Project 86" style="height:40px;display:block;" /></div>' +
      '<h2 style="margin:0 0 16px 0;color:#111827;font-size:20px;">' + escHtml(opts.heading) + '</h2>' +
      (opts.bodyHtml || '') +
      (opts.button && opts.button.href
        ? '<p><a href="' + escHtml(opts.button.href) + '" style="display:inline-block;background:#4f8cff;color:#fff;text-decoration:none;padding:10px 20px;border-radius:6px;font-weight:600;">' + escHtml(opts.button.label) + '</a></p>'
        : '') +
      '<div style="margin-top:32px;padding-top:16px;border-top:1px solid #e5e7eb;font-size:12px;color:#6b7280;">' +
        (opts.footerHtml || '') +
      '</div>' +
    '</div>' +
  '</body></html>';
}

// rows: [[label, value]] with plain-text values; empty values are skipped.
function rowsHtml(rows) {
  const kept = (rows || []).filter(function (r) { return r && r[1]; });
  if (!kept.length) return '';
  return '<table style="border-collapse:collapse;margin:12px 0;font-size:14px;">' +
    kept.map(function (r) {
      return '<tr><td style="padding:5px 10px;color:#6b7280;">' + escHtml(r[0]) + '</td><td style="padding:5px 10px;">' + escHtml(r[1]) + '</td></tr>';
    }).join('') +
  '</table>';
}

function rowsText(rows) {
  return (rows || []).filter(function (r) { return r && r[1]; })
    .map(function (r) { return r[0] + ': ' + r[1]; }).join('\n');
}

function greetingName(recipient) {
  return oneLine(recipient && recipient.name, 80) || 'there';
}

function parentRow(ticket, site) {
  const jobLine = jobLineOf(site);
  return [ticket && ticket.job_id ? 'Job' : 'Lead', jobLine];
}

function footerSentence(sentence) {
  return {
    text: sentence + ' ' + NOTIFY_FOOTER_TEXT,
    html: escHtml(sentence) + ' ' + NOTIFY_FOOTER_HTML,
  };
}

function pushBody(jobLine, title, rest) {
  return oneLine((jobLine ? jobLine + ' — ' : '') + title + ': ' + rest, 400);
}

const PRIORITY_LABELS = { high: 'High', urgent: 'Urgent' };

/**
 * assignmentMessage({ticket, site, assigner, recipient, tally:{total, done}})
 *   -> {subject, html, text, push}
 * assigner is the office label (already a name), recipient the users row.
 */
function assignmentMessage(o) {
  const opts = o || {};
  const ticket = opts.ticket || {};
  const site = opts.site || {};
  const title = titleOf(ticket);
  const jobLine = jobLineOf(site);
  const assigner = oneLine(opts.assigner, 80) || 'A teammate';
  const link = ticketLink(ticket);
  const total = Number(opts.tally && opts.tally.total) || 0;
  const done = Number(opts.tally && opts.tally.done) || 0;
  const rows = [
    parentRow(ticket, site),
    ['Address', oneLine(site.address, 300)],
    ['Scheduled', calendarDayLabel(ticket.scheduled_for)],
    ['Due', calendarDayLabel(ticket.due_date)],
    ['Priority', PRIORITY_LABELS[String(ticket.priority || '').toLowerCase()] || ''],
    ['Punch list', total > 0 ? done + ' of ' + plural(total, 'building') + ' done' : ''],
  ];
  const footer = footerSentence("You're receiving this because a work order was assigned to you.");
  const name = greetingName(opts.recipient);
  const subject = 'Assigned to you: ' + title + (jobLine ? ' — ' + jobLine : '');
  const html = emailShell({
    heading: 'A work order was assigned to you',
    bodyHtml: '<p>Hi ' + escHtml(name) + ',</p>' +
      '<p>' + escHtml(assigner) + ' assigned you <strong>' + escHtml(title) + '</strong>.</p>' +
      rowsHtml(rows),
    button: { label: 'Open work order', href: link },
    footerHtml: footer.html,
  });
  const rowText = rowsText(rows);
  const text =
    'Hi ' + name + ',\n\n' +
    assigner + ' assigned you "' + title + '".\n' +
    (rowText ? '\n' + rowText + '\n' : '') +
    '\nOpen work order: ' + link + '\n\n' +
    footer.text;
  return {
    subject: subject,
    html: html,
    text: text,
    push: {
      title: '📋 Assigned to you',
      body: pushBody(jobLine, title, 'assigned by ' + assigner + '.'),
      url: link,
      tag: 'ticket_assignment:' + ticket.id,
    },
  };
}

// "Bldg 784" out of "Bldg 784 — Side A: post": the same parse the crew page uses.
function headOf(title) {
  const t = oneLine(title, 200);
  const m = /^(.+?)\s+[—–-]\s+(.+)$/.exec(t);
  return m ? m[1] : t;
}

/**
 * sentBackCrewEmail({orgName, title, site, sendBack:{note, buildings}, recipientName})
 *   -> {subject, html, text}
 * CREW-FACING. No link (the link's token is stored hashed and cannot be
 * rebuilt), no prices, no push. Reads only the title, the site's name and
 * address and the office's reason texts.
 */
function sentBackCrewEmail(o) {
  const opts = o || {};
  const site = opts.site || {};
  const title = oneLine(opts.title, 200) || 'Work order';
  const siteName = oneLine(site.name, 200);
  const org = oneLine(opts.orgName, 120);
  const sendBack = opts.sendBack || {};
  const note = String(sendBack.note == null ? '' : sendBack.note)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .trim()
    .slice(0, 1000);
  const buildings = (Array.isArray(sendBack.buildings) ? sendBack.buildings : [])
    .map(function (b) {
      const head = headOf(b && b.title);
      const bnote = oneLine(b && b.note, 500);
      return head ? { head: head, note: bnote } : null;
    })
    .filter(Boolean);
  const address = oneLine(site.address, 300);
  const recipient = crewName(opts.recipientName) || 'there';
  const subject = 'Sent back for more work: ' + title + (siteName ? ' — ' + siteName : '');
  const closing = 'Open the work order from the link ' + (org || 'the office') + ' sent you earlier. ' +
    'Add a new completion photo to each building you redo and mark it complete again. ' +
    'The office is told when every building is done.';
  const footer = "You're receiving this because a work order was shared with you at this address.";

  const textParts = [
    'Hi ' + recipient + ',',
    (org || 'The office') + ' sent this work order back for more work: "' + title + '".',
    'What needs fixing:\n' + note,
  ];
  if (buildings.length) {
    textParts.push('Buildings to redo:\n' + buildings.map(function (b) {
      return '- ' + b.head + (b.note ? ' — ' + b.note : '');
    }).join('\n'));
  }
  if (address) textParts.push('Address: ' + address);
  textParts.push(closing);
  textParts.push(footer);
  const text = textParts.join('\n\n');

  const html = '<!doctype html><html><body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;">' +
    '<div style="max-width:560px;margin:24px auto;padding:24px;background:#fff;border-radius:10px;color:#1f2937;line-height:1.5;">' +
      '<p>Hi ' + escHtml(recipient) + ',</p>' +
      '<p>' + escHtml(org || 'The office') + ' sent this work order back for more work: <strong>' + escHtml(title) + '</strong>.</p>' +
      '<p><strong>What needs fixing:</strong><br>' + escHtml(note).replace(/\n/g, '<br>') + '</p>' +
      (buildings.length
        ? '<p><strong>Buildings to redo:</strong></p><ul>' + buildings.map(function (b) {
          return '<li>' + escHtml(b.head) + (b.note ? ' — ' + escHtml(b.note) : '') + '</li>';
        }).join('') + '</ul>'
        : '') +
      (address ? '<p><strong>Address:</strong> ' + escHtml(address) + '</p>' : '') +
      '<p>' + escHtml(closing) + '</p>' +
      '<div style="margin-top:32px;padding-top:16px;border-top:1px solid #e5e7eb;font-size:12px;color:#6b7280;">' + escHtml(footer) + '</div>' +
    '</div>' +
  '</body></html>';
  return { subject: oneLine(subject, 400), html: html, text: text };
}

// "Marco (via the crew link)", or "The crew link" when no name survives.
function crewWho(label) {
  const name = crewName(label);
  return name ? name + ' (via the crew link)' : 'The crew link';
}

/**
 * flagMessage({ticket, site, flag:{id, category, note, task_title, photo_count},
 *              crewLabel, recipient, fallback}) -> {subject, html, text, push}
 * fallback 'admins' swaps the footer: the admin is told because nobody on the
 * work order could open it.
 */
function flagMessage(o) {
  const opts = o || {};
  const ticket = opts.ticket || {};
  const site = opts.site || {};
  const flag = opts.flag || {};
  const label = FLAG_CATEGORY_LABELS[flag.category] || FLAG_CATEGORY_LABELS.other;
  const title = titleOf(ticket);
  const jobLine = jobLineOf(site);
  const link = ticketLink(ticket);
  const who = crewWho(opts.crewLabel);
  const building = oneLine(flag.task_title, 200);
  const note = crewText(flag.note, 500);
  const photos = Number(flag.photo_count) || 0;
  const rows = [
    ['Problem', label],
    ['Note', note],
    ['Photos', photos > 0 ? String(photos) : ''],
    parentRow(ticket, site),
    ['Address', oneLine(site.address, 300)],
  ];
  const footer = footerSentence(opts.fallback === 'admins'
    ? "You're receiving this because you're an admin and nobody on this work order can open it."
    : "You're receiving this because you run this job, sent its crew link, are assigned to this work order or are watching it.");
  const name = greetingName(opts.recipient);
  const subject = 'Problem flagged: ' + label + ' — ' + title + (jobLine ? ' — ' + jobLine : '');
  const html = emailShell({
    heading: 'A crew flagged a problem',
    bodyHtml: '<p>Hi ' + escHtml(name) + ',</p>' +
      '<p>' + escHtml(who) + ' flagged a problem on <strong>' + escHtml(title) + '</strong>' +
      (building ? ' at ' + escHtml(building) : '') + '.</p>' +
      rowsHtml(rows),
    button: { label: 'Open work order', href: link },
    footerHtml: footer.html,
  });
  const rowText = rowsText(rows);
  const text =
    'Hi ' + name + ',\n\n' +
    who + ' flagged a problem on "' + title + '"' + (building ? ' at ' + building : '') + '.\n' +
    (rowText ? '\n' + rowText + '\n' : '') +
    '\nOpen work order: ' + link + '\n\n' +
    footer.text;
  return {
    subject: subject,
    html: html,
    text: text,
    push: {
      title: '⚠️ Problem flagged: ' + label,
      body: pushBody(jobLine, title, crewText(flag.note, 120)),
      url: link,
      tag: 'ticket_problem:' + flag.id,
    },
  };
}

function photoKindOfEvent(detail) {
  const d = detail || {};
  if (d.kind === 'before') return 'before';
  if (d.task_id != null && d.task_id !== '') return 'completion';
  return 'site';
}

function namedList(titles) {
  const shown = titles.slice(0, 5);
  const more = titles.length - shown.length;
  return shown.join(', ') + (more > 0 ? ' and ' + more + ' more' : '');
}

/**
 * crewActivitySummary(events, {taskTitles: Map|object, pendingSuggestions})
 *   -> {lines:[string], quotes:[string], who}
 * events: service_ticket_events rows already chosen for the batch (actor_kind
 * share). The lines, in order: first open, started, took back Mark work
 * complete, finished, reopened,
 * photos, building notes (with up to three quoted), field report note,
 * checklist, suggestions.
 */
function crewActivitySummary(events, o) {
  const opts = o || {};
  const titles = opts.taskTitles instanceof Map
    ? opts.taskTitles
    : new Map(Object.entries(opts.taskTitles || {}));
  const list = (Array.isArray(events) ? events : []).map(function (e) {
    let d = e && e.detail;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch (_) { d = {}; } }
    return { kind: e && e.kind, label: e && e.actor_label, share: e && e.share_id, detail: (d && typeof d === 'object') ? d : {} };
  });
  const titleFor = function (d) {
    const id = d.task_id != null ? String(d.task_id) : '';
    return oneLine(d.title, 200) || oneLine(titles.get(id), 200) || 'A building';
  };
  function distinctTitles(kind) {
    const seen = new Map();
    list.forEach(function (e) {
      if (e.kind !== kind) return;
      const key = e.detail.task_id != null ? String(e.detail.task_id) : ('#' + seen.size);
      if (!seen.has(key)) seen.set(key, titleFor(e.detail));
    });
    return Array.from(seen.values());
  }

  const lines = [];
  const quotes = [];
  if (list.some(function (e) { return e.kind === 'share_opened'; })) lines.push('Opened the work order for the first time');
  // A move to In progress is a start only when it did not come back from Work
  // complete: the crew taking back its own Mark work complete is said as that,
  // and a building reopened at Work complete is the Reopened line below.
  const toInProgress = list.filter(function (e) { return e.kind === 'status_changed' && e.detail.to === 'in_progress'; });
  if (toInProgress.some(function (e) { return e.detail.from !== 'work_complete' && e.detail.reason !== 'crew_undid_finish'; })) lines.push('Started work');
  if (toInProgress.some(function (e) { return e.detail.reason === 'crew_undid_finish'; })) lines.push('Took back Mark work complete — the work order is in progress again');
  const finished = distinctTitles('subtask_completed');
  if (finished.length) lines.push('Finished ' + plural(finished.length, 'building') + ': ' + namedList(finished));
  const reopened = distinctTitles('subtask_reopened');
  if (reopened.length) lines.push('Reopened ' + plural(reopened.length, 'building') + ': ' + namedList(reopened));
  const photos = { completion: 0, before: 0, site: 0 };
  list.forEach(function (e) {
    if (e.kind === 'photo_added') photos[photoKindOfEvent(e.detail)] += 1;
  });
  const photoTotal = photos.completion + photos.before + photos.site;
  if (photoTotal) {
    const parts = [];
    if (photos.completion) parts.push(photos.completion + ' completion');
    if (photos.before) parts.push(photos.before + ' before');
    if (photos.site) parts.push(photos.site + ' site');
    lines.push('Added ' + plural(photoTotal, 'photo') + ' (' + parts.join(', ') + ')');
  }
  const notes = list.filter(function (e) { return e.kind === 'subtask_note' && e.detail.note; });
  if (notes.length) {
    lines.push('Left ' + plural(notes.length, 'note'));
    notes.slice(0, 3).forEach(function (e) {
      quotes.push('“' + crewText(e.detail.note, 160) + '” — ' + titleFor(e.detail));
    });
  }
  const fieldNotes = list.filter(function (e) { return e.kind === 'note_added'; }).length;
  if (fieldNotes) lines.push(fieldNotes === 1 ? 'Added a field report note' : 'Added ' + fieldNotes + ' field report notes');
  if (list.some(function (e) {
    return (e.kind === 'field_changed' || e.kind === 'note_added') &&
      Array.isArray(e.detail.fields) && e.detail.fields.indexOf('checklist') >= 0;
  })) lines.push('Updated the checklist');
  const suggested = list.filter(function (e) { return e.kind === 'revision_proposed'; }).length;
  if (suggested) {
    const waiting = Number(opts.pendingSuggestions) || 0;
    lines.push('Suggested ' + plural(suggested, 'change') + (waiting > 0 ? ' — ' + waiting + ' waiting for you' : ''));
  }

  const names = [];
  const shares = new Set();
  list.forEach(function (e) {
    if (e.share) shares.add(String(e.share));
    const n = crewName(e.label);
    if (n && names.indexOf(n) < 0) names.push(n);
  });
  let who;
  if (names.length === 1) who = names[0] + ' (via the crew link)';
  else if (names.length === 2) who = names[0] + ' and ' + names[1] + ' (via crew links)';
  else if (names.length > 2) who = names[0] + ' and ' + (names.length - 1) + ' others (via crew links)';
  else who = shares.size > 1 ? 'Crews (via crew links)' : 'The crew (via the crew link)';
  return { lines: lines, quotes: quotes, who: who };
}

/**
 * crewActivityMessage({ticket, site, summary:{lines, quotes, who}, recipient})
 *   -> {subject, html, text, push}
 */
function crewActivityMessage(o) {
  const opts = o || {};
  const ticket = opts.ticket || {};
  const site = opts.site || {};
  const summary = opts.summary || { lines: [], quotes: [], who: 'The crew (via the crew link)' };
  const lines = summary.lines || [];
  const quotes = summary.quotes || [];
  const title = titleOf(ticket);
  const jobLine = jobLineOf(site);
  const link = ticketLink(ticket);
  const name = greetingName(opts.recipient);
  const rows = [parentRow(ticket, site), ['Address', oneLine(site.address, 300)]];
  const footer = footerSentence('At most one of these per work order every 30 minutes. ' +
    "You're receiving this because you run this job, sent its crew link, are assigned to this work order or are watching it.");
  const noteLine = lines.findIndex(function (l) { return /^Left \d+ notes?$/.test(l); });
  const subject = 'Crew update: ' + title + (jobLine ? ' — ' + jobLine : '');
  const html = emailShell({
    heading: 'Crew update',
    bodyHtml: '<p>Hi ' + escHtml(name) + ',</p>' +
      '<p>' + escHtml(summary.who) + ' on <strong>' + escHtml(title) + '</strong>:</p>' +
      '<ul>' + lines.map(function (l, i) {
        return '<li>' + escHtml(l) +
          (i === noteLine && quotes.length
            ? '<ul>' + quotes.map(function (q) { return '<li>' + escHtml(q) + '</li>'; }).join('') + '</ul>'
            : '') +
          '</li>';
      }).join('') + '</ul>' +
      rowsHtml(rows),
    button: { label: 'Open work order', href: link },
    footerHtml: footer.html,
  });
  const rowText = rowsText(rows);
  const text =
    'Hi ' + name + ',\n\n' +
    summary.who + ' on "' + title + '":\n' +
    lines.map(function (l, i) {
      return '- ' + l + (i === noteLine && quotes.length
        ? '\n' + quotes.map(function (q) { return '  ' + q; }).join('\n')
        : '');
    }).join('\n') + '\n' +
    (rowText ? '\n' + rowText + '\n' : '') +
    '\nOpen work order: ' + link + '\n\n' +
    footer.text;
  return {
    subject: subject,
    html: html,
    text: text,
    push: {
      title: '🛠 Crew update',
      body: pushBody(jobLine, title, lines.slice(0, 2).join('; ')),
      url: link,
      tag: 'ticket_crew_activity:' + ticket.id,
    },
  };
}

// The company-wide list lives on the Service Tickets page (js/work-orders-board.js
// renders it there); /work-orders only redirects to it, so link the real path.
function workOrdersUrl() {
  return appUrl() + '/service-tickets';
}

// FIRST, deliberately: since 1.33 a building is off every task list, so for a
// crew lead this row is the only place the work assigned to them is named — and
// it is the most actionable thing in the email for everyone else too.
const DIGEST_SECTIONS = Object.freeze([
  { key: 'your_buildings', label: 'Buildings assigned to you',
    push: function (n) { return plural(n, 'work order') + ' with your buildings'; } },
  { key: 'approvals', label: 'Ready for your approval', push: function (n) { return n + ' to approve'; } },
  { key: 'flags', label: 'Problems flagged by crews', push: function (n) { return plural(n, 'problem') + ' flagged'; } },
  { key: 'overdue', label: 'Overdue', push: function (n) { return n + ' overdue'; } },
  { key: 'unopened', label: 'Crew scheduled soon, link not opened', push: function (n) { return plural(n, 'link') + ' not opened'; } },
  { key: 'expiring', label: 'Crew links expiring soon', push: function (n) { return plural(n, 'link') + ' expiring'; } },
  { key: 'suggestions', label: 'Suggestions waiting over a day', push: function (n) { return plural(n, 'suggestion') + ' waiting'; } },
]);

// One grey sub-line per digest row. Items (each also carries `ticket` and
// `site` or `jobLine`):
//   approvals   {daysWaiting, over}
//   flags       {category, flaggedAt}
//   overdue     {dueDate, done, total}
//   unopened    {when:'today'|'tomorrow', linkSent}
//   expiring    {crewName, expiresAt}
//   suggestions {count}
//   your_buildings {count, nextDue}   a count and a calendar day, never a price
function digestSubLine(key, item, ctx) {
  const it = item || {};
  const parts = [lineFor(it)];
  const red = [];
  if (key === 'your_buildings') {
    parts.push(plural(Number(it.count) || 0, 'building') + ' still open');
    const due = calendarDayLabel(it.nextDue);
    if (due) parts.push('next due ' + due);
  } else if (key === 'approvals') {
    const d = Number(it.daysWaiting) || 0;
    parts.push('waiting ' + plural(d, 'day'));
    if (it.over) red.push('over ' + plural(ctx.overDays, 'business day'));
  } else if (key === 'flags') {
    parts.push(FLAG_CATEGORY_LABELS[it.category] || FLAG_CATEGORY_LABELS.other);
    const when = instantDayLabel(it.flaggedAt, ctx.zone);
    if (when) parts.push('flagged ' + when);
  } else if (key === 'overdue') {
    const due = calendarDayLabel(it.dueDate);
    if (due) parts.push('due ' + due);
    const total = Number(it.total) || 0;
    if (total > 0) parts.push((Number(it.done) || 0) + ' of ' + plural(total, 'building') + ' done');
  } else if (key === 'unopened') {
    parts.push('scheduled ' + (it.when === 'tomorrow' ? 'tomorrow' : 'today'));
    parts.push(it.linkSent ? 'link sent, not opened yet' : 'no crew link sent');
  } else if (key === 'expiring') {
    const who = crewName(it.crewName) || 'the crew';
    const when = instantDayLabel(it.expiresAt, ctx.zone);
    parts.push('link to ' + who + ' expires' + (when ? ' ' + when : ' soon'));
  } else if (key === 'suggestions') {
    parts.push(plural(Number(it.count) || 0, 'suggestion') + ' from the crew');
  }
  return { plain: parts.filter(Boolean).join(' · '), red: red.join(' · ') };
}

/**
 * digestMessage({recipient, sections:{your_buildings, approvals, flags, overdue,
 *   unopened, expiring, suggestions}, overDays, zone, total?})
 *   -> {subject, html, text, push}
 * total defaults to the number of distinct tickets across the sections.
 * The subject's "[N to approve]" prefix keys on `approvals` only — buildings
 * assigned to you are not something to approve.
 */
function digestMessage(o) {
  const opts = o || {};
  const sections = opts.sections || {};
  const ctx = { overDays: Number(opts.overDays) || 2, zone: opts.zone };
  const ids = new Set();
  DIGEST_SECTIONS.forEach(function (s) {
    (sections[s.key] || []).forEach(function (it) {
      if (it && it.ticket && it.ticket.id != null) ids.add(String(it.ticket.id));
    });
  });
  const total = Number.isSafeInteger(opts.total) ? opts.total : ids.size;
  const approvals = (sections.approvals || []).length;
  const first = oneLine(opts.recipient && opts.recipient.name, 80).split(' ')[0];
  const subject = (approvals > 0 ? '[' + approvals + ' to approve] ' : '') + 'Work orders needing you today (' + total + ')';
  const lead = total === 1 ? '1 work order needs your attention.' : total + ' work orders need your attention.';
  const heading = first ? 'Good morning, ' + first : 'Good morning';
  const footer = footerSentence("You're receiving this because work orders you're on need attention.");
  const url = workOrdersUrl();

  let bodyHtml = '<p>' + escHtml(lead) + '</p>';
  const textParts = [heading, lead];
  const pushParts = [];
  DIGEST_SECTIONS.forEach(function (s) {
    const items = (sections[s.key] || []).filter(function (it) { return it && it.ticket; });
    if (!items.length) return;
    pushParts.push(s.push(items.length));
    const head = s.label + ' (' + items.length + ')';
    bodyHtml += '<h3 style="margin:18px 0 6px 0;font-size:15px;color:#111827;">' + escHtml(head) + '</h3>';
    const textRows = [head];
    items.forEach(function (it) {
      const t = titleOf(it.ticket);
      const link = ticketLink(it.ticket);
      const sub = digestSubLine(s.key, it, ctx);
      bodyHtml += '<div style="margin:0 0 8px 0;">' +
        '<a href="' + escHtml(link) + '" style="color:#1d4ed8;text-decoration:none;font-weight:600;">' + escHtml(t) + '</a>' +
        '<div style="font-size:12px;color:#6b7280;">' + escHtml(sub.plain) +
          (sub.red ? '<span style="color:#b91c1c;"> · ' + escHtml(sub.red) + '</span>' : '') +
        '</div>' +
      '</div>';
      textRows.push('- ' + t + '\n  ' + sub.plain + (sub.red ? ' · ' + sub.red : '') + '\n  ' + link);
    });
    textParts.push(textRows.join('\n'));
  });
  textParts.push('Open Service Tickets: ' + url);
  textParts.push(footer.text);
  const html = emailShell({
    heading: heading,
    bodyHtml: bodyHtml,
    button: { label: 'Open Service Tickets', href: url },
    footerHtml: footer.html,
  });
  return {
    subject: subject,
    html: html,
    text: textParts.join('\n\n'),
    push: {
      title: '🛠 Work orders need you',
      body: pushParts.join(' · '),
      url: url,
      tag: 'work_order_digest',
    },
  };
}

/**
 * waitingReminderMessage({recipient, items:[{ticket, site|jobLine, businessDays}], overDays})
 *   -> {subject, html, text, push}
 */
function waitingReminderMessage(o) {
  const opts = o || {};
  const items = (opts.items || []).filter(function (it) { return it && it.ticket; });
  const n = items.length;
  const overDays = Number(opts.overDays) || 2;
  const url = workOrdersUrl();
  const subject = 'Still waiting for approval: ' + plural(n, 'work order');
  const lead = 'These work orders have waited more than ' + plural(overDays, 'business day') + ':';
  const footer = footerSentence("You're receiving this because work orders you can approve are still waiting.");
  let bodyHtml = '<p>Hi ' + escHtml(greetingName(opts.recipient)) + ',</p><p>' + escHtml(lead) + '</p>';
  const rows = [];
  items.forEach(function (it) {
    const t = titleOf(it.ticket);
    const link = ticketLink(it.ticket);
    const sub = [lineFor(it), 'waiting ' + plural(Number(it.businessDays) || 0, 'business day')].filter(Boolean).join(' · ');
    bodyHtml += '<div style="margin:0 0 8px 0;">' +
      '<a href="' + escHtml(link) + '" style="color:#1d4ed8;text-decoration:none;font-weight:600;">' + escHtml(t) + '</a>' +
      '<div style="font-size:12px;color:#6b7280;">' + escHtml(sub) + '</div>' +
    '</div>';
    rows.push('- ' + t + '\n  ' + sub + '\n  ' + link);
  });
  const text = [
    'Hi ' + greetingName(opts.recipient) + ',',
    lead + '\n' + rows.join('\n'),
    'Open Service Tickets: ' + url,
    footer.text,
  ].join('\n\n');
  return {
    subject: subject,
    html: emailShell({
      heading: 'Still waiting for approval',
      bodyHtml: bodyHtml,
      button: { label: 'Open Service Tickets', href: url },
      footerHtml: footer.html,
    }),
    text: text,
    push: {
      title: '⏳ Still waiting for approval',
      body: plural(n, 'work order') + ' ' + (n === 1 ? 'has' : 'have') + ' waited more than ' + plural(overDays, 'business day') + '.',
      url: url,
      tag: 'ticket_waiting',
    },
  };
}

module.exports = {
  FLAG_CATEGORY_LABELS,
  appUrl,
  escHtml,
  oneLine,
  crewName,
  crewText,
  ticketLink,
  positiveInt,
  asDate,
  businessDaysSince,
  reminderBusinessDays,
  calendarDayLabel,
  instantDayLabel,
  jobLineOf,
  headOf,
  emailShell,
  assignmentMessage,
  sentBackCrewEmail,
  flagMessage,
  crewActivitySummary,
  crewActivityMessage,
  digestMessage,
  waitingReminderMessage,
};
