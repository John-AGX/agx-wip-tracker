'use strict';

// Job types — the type → prefix → counter registry, in one place.
//
// A job number is IDENTITY in this app. It is not a stored column: it lives
// at jobs.data->>'jobNumber', and it is minted by claiming the next counter
// for a type. The registry that defines those types is per-org and lives at
// organizations.branding.job_types — [{ key, label, prefix, pad, next }] —
// written by Admin → Organization → Job Numbering and consumed by
// POST /api/org/next-job-number, which serializes claims with FOR UPDATE.
//
// This module exists because the SHAPE of that registry was defined in three
// places that had to agree and had no way to: normJobTypes() in
// org-manifest-routes.js, seedJobTypesFromJobs() in js/admin.js, and a
// hardcoded /^(S|RV)\d{1,6}$/ in the convert path. Adding a fourth type made
// that disagreement expensive — the convert regex REJECTED two of the three
// types the admin UI seeds (WO was already unconvertible), so a type could
// exist in the registry, claim a number correctly, and still be impossible to
// create a job under. The defaults now have one home and the doors read it.
//
// M — MID-TIER SERVICE. Added 2026-08. AGX runs two kinds of service work:
// single-visit tickets (S) and jobs in the ~$10-50k band that run a few days
// with several discrete pieces of work. Those were being numbered S or RV by
// feel. M gives them their own counter.
//
//   NOTE ON DOLLAR BANDS: the band is CONVENTION, not data. Nothing in this
//   registry, this schema, or this codebase records a min/max per type or
//   compares contractAmount against jobType anywhere. normJobTypes() would
//   silently drop a `min`/`max` field if one were added to a registry entry.
//   Recording and/or enforcing the band is a separate decision — see the
//   open questions this work shipped with.
//
// NOTHING HERE RENUMBERS ANYTHING. backfill() only ever APPENDS a missing
// type to an org's registry; it never reads, rewrites, or reclassifies a job.

// The product's default types, in display order. `next` is deliberately
// absent — a counter is per-org state, not a default.
const DEFAULT_JOB_TYPES = [
  { key: 'service', label: 'Service', prefix: 'S', pad: 4 },
  { key: 'mid_tier_service', label: 'Mid-Tier Service', prefix: 'M', pad: 4 },
  { key: 'renovation', label: 'Renovation', prefix: 'RV', pad: 4 },
  { key: 'work_order', label: 'Work Order', prefix: 'WO', pad: 4 },
];

// Bumped when a NEW default type is introduced. Stamped per-org at
// branding.job_types_v so the introduction runs exactly once — an org that
// then DELETES the type keeps it deleted instead of having it resurrected on
// the next boot.
const JOB_TYPES_VERSION = 2;

// Which prefixes v2 introduces. Kept explicit rather than "every default that
// is missing" for that same reason: re-asserting the whole default set would
// undelete every type an org had deliberately removed.
const INTRODUCED_BY_VERSION = { 2: ['M'] };

// Normalize a registry array → [{key,label,prefix,pad,next}], de-duped on
// prefix, capped. Anything unrecognized is dropped. This is the shape every
// reader may assume.
function normJobTypes(arr) {
  if (!Array.isArray(arr)) return [];
  var seen = {};
  return arr.slice(0, 24).map(function (t) {
    if (!t || typeof t !== 'object') return null;
    var prefix = String(t.prefix == null ? '' : t.prefix).trim().toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
    if (!prefix || seen[prefix]) return null;
    seen[prefix] = true;
    var label = String(t.label == null ? '' : t.label).trim().slice(0, 40) || prefix;
    var key = String(t.key == null ? '' : t.key).trim().toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 32) || prefix.toLowerCase();
    var pad = Math.max(1, Math.min(8, parseInt(t.pad, 10) || 4));
    var next = Math.max(1, parseInt(t.next, 10) || 1);
    return { key: key, label: label, prefix: prefix, pad: pad, next: next };
  }).filter(Boolean);
}

// A fresh copy of the defaults with counters at 1. Used as the fallback when
// an org has no registry yet, so a brand-new tenant can claim a number
// without an admin having to visit the settings page first. The claim path
// floors above the highest EXISTING number for the prefix, so seeding at 1
// can never re-issue a taken number.
function defaultJobTypes() {
  return DEFAULT_JOB_TYPES.map(function (t) {
    return { key: t.key, label: t.label, prefix: t.prefix, pad: t.pad, next: 1 };
  });
}

function padNumber(n, pad) {
  var s = String(Math.max(1, parseInt(n, 10) || 1));
  var width = Math.max(1, Math.min(8, parseInt(pad, 10) || 4));
  while (s.length < width) s = '0' + s;
  return s;
}

// The prefixes a job number may legitimately carry for this org. Falls back
// to the product defaults when the org has no registry — the alternative is
// refusing every job number on a tenant that has never opened the settings
// page, which is how WO became unconvertible.
function allowedPrefixes(storedTypes) {
  var types = normJobTypes(storedTypes);
  if (!types.length) types = defaultJobTypes();
  return types.map(function (t) { return t.prefix; });
}

// Is this a job number this org can carry? Returns the normalized (uppercase
// prefix) value, or null. Shape is 1-4 letters + 1-6 digits, which is the same
// rule js/job-finalize.js normalizeNumber() applies client-side.
function normalizeJobNumber(value, storedTypes) {
  var m = String(value == null ? '' : value).trim().match(/^([A-Za-z]{1,4})\s*(\d{1,6})$/);
  if (!m) return null;
  var prefix = m[1].toUpperCase();
  if (allowedPrefixes(storedTypes).indexOf(prefix) < 0) return null;
  return prefix + m[2];
}

/* ── Reading a job number back to its type ─────────────────────────────
 * THE INVARIANT: a job's TYPE must agree with its NUMBER's prefix.
 *
 * The number is IDENTITY — it is printed on purchase orders, pay
 * applications, signed change orders and the QuickBooks project name — and
 * its prefix is chosen by the coordinator at creation out of this same
 * registry. So the prefix already ENCODES the type. Deriving the type from
 * the number is self-consistent and cannot drift; copying a word off the
 * lead (which is what both convert paths did) can only ever be right by
 * coincidence, and 'Service & Repair' is not a job type and never will be.
 *
 * These mirror prefixForNumber/labelForPrefix/labelForNumber in
 * js/job-finalize.js, off the same registry shape. The whole leading letter
 * RUN is extracted and looked up exactly, so 'RV2044' yields 'RV' and never
 * 'R' — no longest-prefix-first ordering hazard.
 * ─────────────────────────────────────────────────────────────────────*/
function typesOrDefaults(storedTypes) {
  var types = normJobTypes(storedTypes);
  return types.length ? types : defaultJobTypes();
}

function prefixForNumber(value, storedTypes) {
  var m = String(value == null ? '' : value).trim().toUpperCase().match(/^([A-Z]{1,4})\s*\d/);
  if (!m) return '';
  var p = m[1];
  var t = typesOrDefaults(storedTypes).find(function (x) { return String(x.prefix || '').toUpperCase() === p; });
  return t ? String(t.prefix).toUpperCase() : '';
}

function labelForPrefix(prefix, storedTypes) {
  if (!prefix) return '';
  var p = String(prefix).toUpperCase();
  var t = typesOrDefaults(storedTypes).find(function (x) { return String(x.prefix || '').toUpperCase() === p; });
  return t ? String(t.label || p) : '';
}

// '' when the number carries no prefix this org numbers under. Callers that
// have already passed normalizeJobNumber() are guaranteed a non-empty label,
// because both read the same allowed set.
function labelForNumber(value, storedTypes) {
  return labelForPrefix(prefixForNumber(value, storedTypes), storedTypes);
}

// PURE. Append the named default types that this registry is missing, each
// placed after the default that precedes it (so Mid-Tier Service lands next
// to Service rather than at the bottom of the list). `seeds` maps prefix →
// starting counter, so a type whose prefix already appears on hand-typed job
// numbers resumes above them instead of colliding.
//
// Returns { types, added:[prefix] }. `added` empty means nothing changed —
// callers use it to skip the write.
function addMissingTypes(storedTypes, prefixes, seeds) {
  var types = normJobTypes(storedTypes);
  var want = Array.isArray(prefixes) ? prefixes : [];
  var seedMap = seeds || {};
  var added = [];
  DEFAULT_JOB_TYPES.forEach(function (def, defIdx) {
    if (want.indexOf(def.prefix) < 0) return;
    var present = types.some(function (t) { return t.prefix === def.prefix || t.key === def.key; });
    if (present) return;
    var entry = {
      key: def.key,
      label: def.label,
      prefix: def.prefix,
      pad: def.pad,
      next: Math.max(1, parseInt(seedMap[def.prefix], 10) || 1),
    };
    // Anchor: the nearest EARLIER default that this org actually has.
    var at = types.length;
    for (var i = defIdx - 1; i >= 0; i--) {
      var anchor = DEFAULT_JOB_TYPES[i].prefix;
      var pos = types.findIndex(function (t) { return t.prefix === anchor; });
      if (pos >= 0) { at = pos + 1; break; }
    }
    types.splice(at, 0, entry);
    added.push(def.prefix);
  });
  return { types: types, added: added };
}

// One-shot, per-org introduction of the types a new registry version adds.
// Idempotent via branding.job_types_v. Never touches an existing entry's
// label, prefix, pad or counter, and never touches a jobs row.
async function backfill(pool) {
  var introduced = INTRODUCED_BY_VERSION[JOB_TYPES_VERSION] || [];
  var orgs;
  try {
    orgs = (await pool.query('SELECT id, branding FROM organizations')).rows || [];
  } catch (e) {
    console.warn('[job-types] backfill skipped (no organizations table?):', e && e.message);
    return { orgs: 0, changed: 0 };
  }
  var changed = 0;
  for (var i = 0; i < orgs.length; i++) {
    var row = orgs[i];
    var b = (row.branding && typeof row.branding === 'object') ? row.branding : {};
    if (Number(b.job_types_v || 0) >= JOB_TYPES_VERSION) continue;
    var stored = normJobTypes(b.job_types);
    var patch = { job_types_v: JOB_TYPES_VERSION };
    // An org with NO registry is left to seed itself from the defaults (which
    // already include the new types). Only a registry that exists and predates
    // the new type gets the append.
    if (stored.length) {
      var seeds = {};
      for (var p = 0; p < introduced.length; p++) {
        var prefix = introduced[p];
        if (!/^[A-Z]{1,4}$/.test(prefix)) continue;
        try {
          var maxRow = await pool.query(
            "SELECT MAX((substring(j.data->>'jobNumber' from $2))::int) AS m " +
            "  FROM jobs j WHERE j.organization_id = $1 AND j.data->>'jobNumber' ~ $3",
            [row.id, '^' + prefix + '([0-9]+)$', '^' + prefix + '[0-9]+$']
          );
          seeds[prefix] = Number((maxRow.rows[0] && maxRow.rows[0].m) || 0) + 1;
        } catch (e) {
          seeds[prefix] = 1;
        }
      }
      var merged = addMissingTypes(stored, introduced, seeds);
      if (merged.added.length) {
        patch.job_types = merged.types;
        console.log('[job-types] org', row.id, '— added job type(s):', merged.added.join(', '));
      }
    }
    try {
      await pool.query(
        'UPDATE organizations SET branding = COALESCE(branding, \'{}\'::jsonb) || $2::jsonb, updated_at = NOW() WHERE id = $1',
        [row.id, JSON.stringify(patch)]
      );
      changed++;
    } catch (e) {
      console.warn('[job-types] backfill failed for org', row.id, e && e.message);
    }
  }
  return { orgs: orgs.length, changed: changed };
}

module.exports = {
  DEFAULT_JOB_TYPES: DEFAULT_JOB_TYPES,
  JOB_TYPES_VERSION: JOB_TYPES_VERSION,
  INTRODUCED_BY_VERSION: INTRODUCED_BY_VERSION,
  normJobTypes: normJobTypes,
  defaultJobTypes: defaultJobTypes,
  padNumber: padNumber,
  allowedPrefixes: allowedPrefixes,
  normalizeJobNumber: normalizeJobNumber,
  prefixForNumber: prefixForNumber,
  labelForPrefix: labelForPrefix,
  labelForNumber: labelForNumber,
  addMissingTypes: addMissingTypes,
  backfill: backfill,
};
