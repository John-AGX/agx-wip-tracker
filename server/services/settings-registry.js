// Settings registry — the ONE place a feature declares what it can be
// configured with.
//
// WHY THIS EXISTS. Project 86 had no pattern for adding a setting. Config
// lived in three unrelated places: seven columns on `organizations`, a
// handful of app_settings JSONB keys, and scattered per-user prefs. So
// when a feature shipped there was no obvious place to put a setting, and
// it shipped without one — markets, tasks, bills, pay-app retainage,
// assemblies, doc import, background jobs and the reminders morning-gate
// all went out with nothing configurable at all.
//
// A registry turns "add a setting" from a UI project into a five-line
// declaration. Three things fall out of that:
//   1. The admin dashboard renders any group generically — no per-feature
//      form to hand-build, so the next feature can't skip it for cost.
//   2. Every setting is inspectable and countable. "7 of 23 set" is a
//      number you can watch, instead of a thing nobody tracks.
//   3. The ASSISTANT gets a typed, validated write surface. It can be told
//      "fill in the Tampa market" and know the field names, types, and what
//      counts as valid — rather than needing a bespoke AI tool per feature.
//
// SCOPE is which row a setting is stored on:
//   'market' → a column on markets (per-org already, see markets.organization_id)
//   'org'    → the organization
//   'user'   → the user
// Only 'market' is wired today; the others are declared shapes waiting for
// their consumer, and deliberately not faked.
'use strict';

// type → how the client renders it and how the server coerces it.
//   text · textarea · number · money · percent · date · bool · select · tz
const MARKET_SETTINGS = [
  // ── identity ──────────────────────────────────────────────────────
  { key: 'name',     type: 'text',   group: 'Identity', label: 'Market name', required: true,
    help: 'Display name, e.g. "Tampa". Unique per organization, case-insensitive.' },
  { key: 'code',     type: 'text',   group: 'Identity', label: 'Code', required: true, max: 8,
    help: 'Short code used on chips and job numbers, e.g. TPA.' },
  { key: 'state',    type: 'text',   group: 'Identity', label: 'State', max: 2,
    help: 'Two-letter state. Drives which licence and registration apply.' },
  { key: 'timezone', type: 'tz',     group: 'Identity', label: 'Timezone', required: true,
    help: 'IANA zone. Every reminder, digest and cert email for this market fires against it — Arizona is America/Phoenix and does NOT observe DST.' },
  { key: 'color',    type: 'color',  group: 'Identity', label: 'Colour',
    help: 'Chip and map-pin colour for this market.' },

  // ── contact ───────────────────────────────────────────────────────
  { key: 'address',  type: 'text',   group: 'Contact', label: 'Office address' },
  { key: 'phone',    type: 'text',   group: 'Contact', label: 'Phone' },

  // ── compliance (per STATE, which is why it lives per market) ──────
  { key: 'license_no',             type: 'text', group: 'Compliance', label: 'Contractor licence #' },
  { key: 'license_expiry',         type: 'date', group: 'Compliance', label: 'Licence expires' },
  { key: 'state_registration_no',  type: 'text', group: 'Compliance', label: 'State registration #',
    help: 'State-level registration. Federal EIN is per COMPANY and lives on the organization, not here.' },
  { key: 'insurance_carrier',      type: 'text', group: 'Compliance', label: 'Insurance carrier' },
  { key: 'insurance_policy_no',    type: 'text', group: 'Compliance', label: 'Insurance policy #' },
  { key: 'insurance_expiry',       type: 'date', group: 'Compliance', label: 'Insurance expires' },
  { key: 'workers_comp_carrier',   type: 'text', group: 'Compliance', label: 'Workers comp carrier' },
  { key: 'workers_comp_policy_no', type: 'text', group: 'Compliance', label: 'Workers comp policy #' },
  { key: 'workers_comp_expiry',    type: 'date', group: 'Compliance', label: 'Workers comp expires' },
  { key: 'bond_carrier',           type: 'text',  group: 'Compliance', label: 'Bond carrier' },
  { key: 'bond_amount',            type: 'money', group: 'Compliance', label: 'Bond amount' },
  { key: 'bond_expiry',            type: 'date',  group: 'Compliance', label: 'Bond expires' },

  // ── money defaults ────────────────────────────────────────────────
  // ⚠ INERT. Nothing reads these yet — see the note in db.js. They are
  // recorded here so they can be filled and reviewed; wiring any of them
  // into the estimating path is a money-model change that needs its own
  // decision, not a side effect of the field existing.
  { key: 'sales_tax_rate',      type: 'percent', group: 'Money defaults', label: 'Sales tax rate',
    help: 'Whole points, e.g. 7 for 7%.' },
  { key: 'labor_rate_default',  type: 'money',   group: 'Money defaults', label: 'Default labour rate',
    help: 'Per hour.' },
  { key: 'target_margin_pct',   type: 'percent', group: 'Money defaults', label: 'Target margin',
    help: 'NOT YET APPLIED to estimates — recorded only.' },
  { key: 'overhead_pct',        type: 'percent', group: 'Money defaults', label: 'Overhead',
    help: 'NOT YET APPLIED — recorded only.' },
  { key: 'default_markup_pct',  type: 'percent', group: 'Money defaults', label: 'Default markup',
    help: 'NOT YET APPLIED — recorded only.' },
  { key: 'travel_minimum',      type: 'money',   group: 'Money defaults', label: 'Travel minimum' },
  { key: 'mobilization_fee',    type: 'money',   group: 'Money defaults', label: 'Mobilisation fee' },
];

const REGISTRY = {
  market: {
    scope: 'market',
    title: 'Market settings',
    describe: 'Per-market configuration. Markets belong to one organization, so a second tenant gets its own set automatically.',
    settings: MARKET_SETTINGS,
  },
};

/** Ordered, de-duplicated group names for a scope — drives render order. */
function groupsFor(scope) {
  var r = REGISTRY[scope];
  if (!r) return [];
  var seen = {}, out = [];
  r.settings.forEach(function (s) {
    if (!seen[s.group]) { seen[s.group] = 1; out.push(s.group); }
  });
  return out;
}

/**
 * How many of a scope's settings are actually filled on a given row.
 * This is what makes "7 of 23 set" a real number rather than a guess —
 * and what lets the dashboard nag about markets that are still blank.
 *
 * Required identity fields are excluded: name/code/timezone are always
 * present (the API refuses to create a market without them), so counting
 * them would flatter every market by three.
 */
function completeness(scope, row) {
  var r = REGISTRY[scope];
  if (!r || !row) return { set: 0, total: 0 };
  var optional = r.settings.filter(function (s) { return !s.required; });
  var set = optional.filter(function (s) {
    var v = row[s.key];
    return v !== null && v !== undefined && v !== '';
  }).length;
  return { set: set, total: optional.length };
}

module.exports = { REGISTRY, MARKET_SETTINGS, groupsFor, completeness };
