// Plan catalog — the commercialization source of truth.
//
// Defines the subscription tiers the platform CAN sell. This is the
// SaaS-scaffold seam: today AGX runs on the 'internal' plan (unlimited,
// not publicly purchasable), so every limit is null and every feature
// flag is true — which means the entitlements layer is a NO-OP for the
// live org. When you're ready to actually charge, you flip features /
// tune limits here and wire Stripe to set organizations.plan_key — no
// code changes at the call sites.
//
// Mirrors the code-defined-catalog pattern already used by
// feature-catalog.js, field-tool-catalog.js, and email-events.js:
// version-controlled, no DB round-trip, trivially diffable.
//
// Shape of a plan:
//   key            machine id, stored in organizations.plan_key
//   name           display name
//   blurb          one-line pitch (pricing page / upgrade prompts)
//   public         true = appears on the pricing page / signup picker.
//                  false = internal/comp/legacy plans you assign by hand.
//   price_monthly  USD/month, or null for not-publicly-priced
//   price_yearly   USD/year (usually ~10x monthly), or null
//   limits         hard caps. null on any key = UNLIMITED. The
//                  entitlements layer treats a missing key as unlimited
//                  too, so adding a new meter later defaults to "no cap"
//                  until you set one here.
//   features       boolean feature flags. A missing key is treated as
//                  FALSE by can() — so a brand-new gated feature is off
//                  for every plan until you opt each tier in. (internal
//                  is the exception: it answers true to everything via
//                  the UNLIMITED sentinel below.)
//
// Limit keys (the metering vocabulary — keep in sync with usage-meter):
//   seats                  max active users in the org
//   active_jobs            max jobs not in Completed/Archived
//   ai_messages_per_month  Ask-86 turns / month (the real cost driver)
//   email_sends_per_month  transactional + campaign emails / month
//   storage_gb             total attachment storage
//
// Feature keys (gateable surfaces — reference feature-catalog ids where
// they line up, but these are coarser "whole surface on/off" switches):
//   ai_agent          Ask 86 + payload dispatcher + watches
//   email_campaigns   marketing-style bulk sends (Wave 9)
//   email_templates   branded transactional templates + block editor
//   field_tools       calculators / printouts
//   reports           job/project report builder
//   photo_maps        GPS photo pins + map layouts
//   sheet_editor      Plans & Takeoffs CAD sheet editor
//   weekly_digests    Monday role-targeted digest cron
//   api_access        (future) outbound API / webhooks

'use strict';

// Sentinel for the internal/unlimited tier. entitlementsFor() checks
// for this object identity to short-circuit every limit to null and
// every feature to true without enumerating them — so the internal
// plan never needs maintenance as new features ship.
const UNLIMITED = { __unlimited: true };

const PLANS = [
  {
    key: 'internal',
    name: 'Internal',
    blurb: 'Unlimited everything. Not publicly purchasable — assigned by hand to first-party / comped orgs.',
    public: false,
    price_monthly: null,
    price_yearly: null,
    limits: UNLIMITED,
    features: UNLIMITED,
  },
  {
    key: 'free',
    name: 'Free',
    blurb: 'Try the core pipeline — leads, estimates, one user. No AI, no campaigns.',
    public: true,
    price_monthly: 0,
    price_yearly: 0,
    limits: {
      seats: 1,
      active_jobs: 5,
      ai_messages_per_month: 0,
      email_sends_per_month: 50,
      storage_gb: 1,
    },
    features: {
      ai_agent: false,
      email_campaigns: false,
      email_templates: false,
      field_tools: true,
      reports: true,
      photo_maps: false,
      sheet_editor: false,
      weekly_digests: false,
      api_access: false,
    },
  },
  {
    key: 'starter',
    name: 'Starter',
    blurb: 'For a small crew running real jobs — AI assistant, reports, photo maps.',
    public: true,
    price_monthly: 49,
    price_yearly: 490,
    limits: {
      seats: 5,
      active_jobs: 50,
      ai_messages_per_month: 500,
      email_sends_per_month: 2000,
      storage_gb: 25,
    },
    features: {
      ai_agent: true,
      email_campaigns: false,
      email_templates: true,
      field_tools: true,
      reports: true,
      photo_maps: true,
      sheet_editor: false,
      weekly_digests: true,
      api_access: false,
    },
  },
  {
    key: 'pro',
    name: 'Pro',
    blurb: 'The full platform — campaigns, takeoffs, the works. For an established shop.',
    public: true,
    price_monthly: 149,
    price_yearly: 1490,
    limits: {
      seats: 25,
      active_jobs: null,           // unlimited
      ai_messages_per_month: 3000,
      email_sends_per_month: 20000,
      storage_gb: 250,
    },
    features: {
      ai_agent: true,
      email_campaigns: true,
      email_templates: true,
      field_tools: true,
      reports: true,
      photo_maps: true,
      sheet_editor: true,
      weekly_digests: true,
      api_access: false,
    },
  },
  {
    key: 'business',
    name: 'Business',
    blurb: 'Multi-crew operations with higher AI + storage ceilings and API access.',
    public: true,
    price_monthly: 399,
    price_yearly: 3990,
    limits: {
      seats: null,                 // unlimited
      active_jobs: null,
      ai_messages_per_month: 12000,
      email_sends_per_month: 100000,
      storage_gb: 1000,
    },
    features: {
      ai_agent: true,
      email_campaigns: true,
      email_templates: true,
      field_tools: true,
      reports: true,
      photo_maps: true,
      sheet_editor: true,
      weekly_digests: true,
      api_access: true,
    },
  },
];

// The plan an org falls back to when plan_key is missing or unknown.
// Use 'internal' so that ANY data integrity hiccup fails OPEN (org
// keeps working) rather than locking a paying customer out. When you
// go commercial you may want to flip this to 'free' so that an
// unknown/expired plan degrades to the free tier instead — but while
// AGX is the only org, fail-open is the safe default.
const DEFAULT_PLAN_KEY = 'internal';

function getPlan(key) {
  return PLANS.find(function (p) { return p.key === key; }) || null;
}

// Plans that show up on a public pricing page / signup plan-picker.
function publicPlans() {
  return PLANS.filter(function (p) { return p.public; });
}

module.exports = {
  PLANS,
  UNLIMITED,
  DEFAULT_PLAN_KEY,
  getPlan,
  publicPlans,
};
