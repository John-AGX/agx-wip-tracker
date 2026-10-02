'use strict';

/* THE SHAPE OF A NOTICE, for every kind of record.
 *
 * These primitives were written for work orders and are not about work orders:
 * the email shell, the escaping, the one-line squeeze, the label/value rows,
 * the footer that tells somebody where the toggle is. They moved here when the
 * money notices needed the same look (services/money-notices.js), because the
 * alternative was a second copy of the shell — and then two email designs, two
 * escapers, and two footers pointing at the same settings page in different
 * words.
 *
 * services/work-order-notify-text.js re-exports every one of them unchanged,
 * so its six callers and its tests did not move.
 *
 * WHAT A MESSAGE IS, in this codebase: an object
 *   { subject, html, text, push: { title, body, url, tag } | null }
 * and services/notice-delivery.js deliver() is the one thing that sends it.
 *
 * ONE-LINE IS A SAFETY RULE, not formatting. Anything a person typed — a name,
 * a title, a reason — goes through oneLine() before it reaches a subject, a
 * push body or a plain-text email, so control characters and line breaks
 * cannot forge a second line ("Approved: <somewhere else>").
 */

const tz = require('../timezone');

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

function ymdToUtcMs(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd || ''));
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
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

// The approval email's logo, card and footer, for every notice in the app.
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

function footerSentence(sentence) {
  return {
    text: sentence + ' ' + NOTIFY_FOOTER_TEXT,
    html: escHtml(sentence) + ' ' + NOTIFY_FOOTER_HTML,
  };
}

function pushBody(jobLine, title, rest) {
  return oneLine((jobLine ? jobLine + ' — ' : '') + title + ': ' + rest, 400);
}

module.exports = {
  NOTIFY_FOOTER_TEXT,
  NOTIFY_FOOTER_HTML,
  appUrl,
  escHtml,
  oneLine,
  positiveInt,
  asDate,
  ymdToUtcMs,
  calendarDayLabel,
  instantDayLabel,
  plural,
  emailShell,
  rowsHtml,
  rowsText,
  greetingName,
  footerSentence,
  pushBody,
};
