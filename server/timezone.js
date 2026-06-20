// Shared timezone utilities — the multi-market backbone.
//
// Project 86 is going multi-market: each organization has a home-market
// IANA timezone (organizations.timezone, default 'America/New_York'), and
// any user can set a personal override (users.timezone, NULL = inherit).
// Every time-gated cron and every date/time rendered in an email resolves
// against the recipient's zone instead of the server's (UTC on Railway).
//
// Implementation note: we use the built-in Intl.DateTimeFormat with a
// `timeZone` option — Node ships full IANA + DST data, so there is NO
// dependency on luxon/moment/dayjs. DST transitions are handled correctly
// because we always ask Intl "what is the wall-clock time in zone X right
// now", never do raw offset math.

'use strict';

const DEFAULT_TZ = 'America/New_York';

// A curated short list for the admin dropdowns — US markets first (AGX's
// near-term footprint), then a few common international zones. The field
// accepts ANY valid IANA string; this is just the convenience menu.
const COMMON_ZONES = [
  { value: 'America/New_York',    label: 'US Eastern (New York)' },
  { value: 'America/Chicago',     label: 'US Central (Chicago)' },
  { value: 'America/Denver',      label: 'US Mountain (Denver)' },
  { value: 'America/Phoenix',     label: 'US Mountain – no DST (Phoenix)' },
  { value: 'America/Los_Angeles', label: 'US Pacific (Los Angeles)' },
  { value: 'America/Anchorage',   label: 'US Alaska (Anchorage)' },
  { value: 'Pacific/Honolulu',    label: 'US Hawaii (Honolulu)' },
  { value: 'America/Halifax',     label: 'Atlantic (Halifax)' },
  { value: 'America/Toronto',     label: 'Canada Eastern (Toronto)' },
  { value: 'Europe/London',       label: 'UK (London)' },
  { value: 'Europe/Paris',        label: 'Central Europe (Paris)' },
  { value: 'UTC',                 label: 'UTC' }
];

// True if `tz` is a usable IANA zone in this Node build. Intl throws a
// RangeError on an unknown timeZone, so we probe with a throwaway format.
function isValidTz(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch (e) {
    return false;
  }
}

// Resolve the effective zone for a recipient: their override → their org's
// zone → the platform default. Invalid/blank values fall through. Always
// returns a valid IANA string.
function resolveTz(userTz, orgTz) {
  if (isValidTz(userTz)) return userTz;
  if (isValidTz(orgTz)) return orgTz;
  return DEFAULT_TZ;
}

// Pull the wall-clock parts of `date` AS SEEN in `tz`. Returns
// { year, month, day, weekday(0=Sun..6=Sat), hour(0-23), minute }.
function partsInTz(date, tz) {
  var d = (date instanceof Date) ? date : new Date(date || Date.now());
  var zone = isValidTz(tz) ? tz : DEFAULT_TZ;
  var fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short'
  });
  var out = {};
  fmt.formatToParts(d).forEach(function (p) {
    if (p.type === 'year') out.year = Number(p.value);
    else if (p.type === 'month') out.month = Number(p.value);
    else if (p.type === 'day') out.day = Number(p.value);
    else if (p.type === 'hour') out.hour = Number(p.value === '24' ? '0' : p.value);
    else if (p.type === 'minute') out.minute = Number(p.value);
    else if (p.type === 'weekday') out.weekday = WEEKDAYS.indexOf(p.value);
  });
  return out;
}

var WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Local hour (0-23) in `tz` for `date` (defaults to now).
function hourInTz(tz, date) {
  return partsInTz(date || new Date(), tz).hour;
}

// Local day-of-week (0=Sun..6=Sat) in `tz` for `date` (defaults to now).
function dayOfWeekInTz(tz, date) {
  return partsInTz(date || new Date(), tz).weekday;
}

// Local calendar date as 'YYYY-MM-DD' in `tz` (defaults to now). Used as
// a per-recipient dedup key so a daily reminder resets at THEIR midnight.
function localDateInTz(tz, date) {
  var p = partsInTz(date || new Date(), tz);
  return p.year + '-' + String(p.month).padStart(2, '0') + '-' + String(p.day).padStart(2, '0');
}

// ISO week key 'YYYY-Www' in `tz` (defaults to now) — per-recipient weekly
// dedup key (weekly digest fires once per local week).
function localWeekInTz(tz, date) {
  var p = partsInTz(date || new Date(), tz);
  // Build a UTC date from the local wall-clock parts so the ISO-week math
  // is timezone-stable (we only care about the date, not the instant).
  var d = new Date(Date.UTC(p.year, p.month - 1, p.day));
  var day = d.getUTCDay() || 7;           // 1=Mon..7=Sun
  d.setUTCDate(d.getUTCDate() + 4 - day); // nearest Thursday
  var yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  var week = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return d.getUTCFullYear() + '-W' + String(week).padStart(2, '0');
}

// Convert a NAIVE local wall-clock string ('2026-06-25T09:00:00', no
// offset / no 'Z') in zone `tz` into the correct UTC instant (a Date).
//
// Why this exists: calendar_events.starts_at is a TIMESTAMPTZ and the
// Railway pg session runs in UTC, so an offset-less datetime string is
// read by Postgres AS UTC — shifting the wall-clock (and, near midnight,
// the calendar DAY) when the client re-renders it in the user's zone.
// 86/Scribe emits a bare local datetime, so we stamp the zone offset here
// before it lands in the column. A string that ALREADY carries an offset
// or 'Z' is unambiguous and returned as-is. Returns null on empty input.
function localWallClockToInstant(naive, tz) {
  if (naive == null || naive === '') return null;
  var s = String(naive).trim();
  // Already zoned (…Z or ±HH:MM) → an unambiguous instant; pass through.
  if (/[zZ]$/.test(s) || /[+\-]\d{2}:?\d{2}$/.test(s)) {
    var d0 = new Date(s);
    return isNaN(d0.getTime()) ? null : d0;
  }
  var m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) {
    var d1 = new Date(s);
    return isNaN(d1.getTime()) ? null : d1;
  }
  var Y = +m[1], Mo = +m[2], D = +m[3], H = +m[4], Mi = +m[5], S = +(m[6] || 0);
  var zone = isValidTz(tz) ? tz : DEFAULT_TZ;
  // Guess the instant as if the wall-clock were UTC, then measure how far
  // `zone` sits from UTC at that instant (DST-correct via Intl) and undo it.
  var guess = Date.UTC(Y, Mo - 1, D, H, Mi, S);
  var p = partsInTz(new Date(guess), zone);
  var asUtcOfParts = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, S);
  var offset = asUtcOfParts - guess; // ms the zone is ahead of UTC
  return new Date(guess - offset);
}

// Format a date/time in `tz` using Intl options (e.g. {weekday, month,
// day, hour, minute}). Falls back gracefully on bad input.
function formatInTz(date, tz, options) {
  if (!date) return '';
  var d = (date instanceof Date) ? date : new Date(date);
  if (isNaN(d.getTime())) return String(date);
  var opts = Object.assign({ timeZone: isValidTz(tz) ? tz : DEFAULT_TZ }, options || {});
  try {
    return new Intl.DateTimeFormat('en-US', opts).format(d);
  } catch (e) {
    return d.toISOString();
  }
}

module.exports = {
  DEFAULT_TZ,
  COMMON_ZONES,
  isValidTz,
  resolveTz,
  partsInTz,
  hourInTz,
  dayOfWeekInTz,
  localDateInTz,
  localWeekInTz,
  localWallClockToInstant,
  formatInTz
};
