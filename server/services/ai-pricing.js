// AI token pricing — the ONE place model rates live.
//
// Extracted from admin-agents-routes.js so a second consumer (the spend
// alarm) can price tokens without importing a route file. That import
// would pull in auth.js, which hard-fails without JWT_SECRET — so a
// background job or a unit test that merely wanted to multiply tokens by
// a rate would refuse to start. Pure arithmetic belongs in services/.
//
// The stronger reason is drift. A price table copied into a second file
// is two facts that must agree forever, and the one that isn't being
// looked at is the one that goes stale. A spend alarm reading rates that
// no longer match the metrics page would either cry wolf or — worse —
// stay quiet through a real overrun. One table, both callers.
//
// Rates are USD per million tokens.
'use strict';

// IMPORTANT: the rate that matters is the rate of the model actually
// RUNNING, which is process.env.AI_MODEL on Railway and NOT the code
// default in ai-routes.js. Those drifted: the default reads
// 'claude-opus-4-8', the live env is claude-sonnet-5, and this table had
// no sonnet-5 row at all — so every dollar figure in the admin pages fell
// through to DEFAULT_MODEL_COST and priced the whole workload at the Opus
// tier (5/25 against a true 2/10). A missing row here is not a small
// error: it is the gauge on every spend decision.
//
// Verified against platform.claude.com/docs/en/about-claude/pricing on
// 2026-10-04. claude-opus-4-5 was ALSO wrong — it carried 15/75, which is
// the retired Opus 4.1 tier; Opus 4.5 is 5/25.
const MODEL_COSTS = {
  'claude-sonnet-5':   { in: 2,    out: 10  },   // live default on Railway
  'claude-sonnet-5-5': { in: 2,    out: 10  },
  'claude-opus-5-5':   { in: 4,    out: 20  },
  'claude-opus-5':     { in: 5,    out: 25  },
  'claude-opus-4-8':   { in: 5,    out: 25  },
  'claude-opus-4-7':   { in: 5,    out: 25  },
  'claude-opus-4-6':   { in: 5,    out: 25  },
  'claude-opus-4-5':   { in: 5,    out: 25  },
  'claude-sonnet-4-6': { in: 3,    out: 15  },
  'claude-sonnet-4-5': { in: 3,    out: 15  },
  'claude-haiku-4-5':  { in: 1,    out: 5   }
};

// Cache READS are 0.1x base input on every current model EXCEPT the two
// the docs call out, so the multiplier belongs per-model rather than
// hardcoded at the one call site that used to own it.
const CACHE_READ_MULTIPLIER = {
  'claude-opus-5-5': 0.05,
  'claude-fable-5-1': 0.025,
  'claude-mythos-5-1': 0.025
};
const DEFAULT_CACHE_READ_MULTIPLIER = 0.10;
const CACHE_WRITE_MULTIPLIER_5M = 1.25;

// WHAT THIS MODULE CANNOT PRICE, stated here so no caller mistakes a
// token cost for a bill. Claude Managed Agents — which is how 86 runs —
// bills a SECOND dimension: $0.08 per session-hour of `running` status,
// on top of every token. Nothing in this repo records session runtime, so
// no function here can return it. A managed-agent cost from this module
// is therefore a token subtotal, never a total. Exported so whoever wires
// runtime does not have to re-derive the rate.
const MANAGED_SESSION_RUNTIME_USD_PER_HOUR = 0.08;

// Fallback for any model not in the table. Mirrors the current Opus tier
// so a newer model rev never makes cost metrics silently collapse to $0 —
// the bug that hid all opus-4-8 spend until 2026-05. Conservative on the
// high side by design: an estimated number beats a missing one, and for
// an alarm, over-reporting fails toward noticing.
const DEFAULT_MODEL_COST = { in: 5, out: 25 };

// The fallback is kept, and now it SAYS it is a fallback. Callers that
// display a number can mark it estimated instead of presenting a guess
// in the same typeface as a known rate.
function rateFor(model) {
  const known = MODEL_COSTS[model];
  if (known) return known;
  return { in: DEFAULT_MODEL_COST.in, out: DEFAULT_MODEL_COST.out, estimated: true, model: model || null };
}

function cacheReadMultiplierFor(model) {
  const m = CACHE_READ_MULTIPLIER[model];
  return typeof m === 'number' ? m : DEFAULT_CACHE_READ_MULTIPLIER;
}

/**
 * Cache-aware cost in USD, unrounded.
 *
 * Cache writes bill at 1.25× the input rate (5-minute TTL — the only one
 * this codebase can produce, since the managed harness exposes no TTL
 * control). Cache reads bill at the model's own read multiplier.
 * Unrounded because a caller summing many rows wants to round ONCE at the
 * end — rounding each row to cents first and then adding compounds the
 * error in whichever direction the rows happen to fall.
 */
function cacheCostRaw(model, inTok, outTok, cacheWrite, cacheRead) {
  const rate = rateFor(model);
  return (
    Number(inTok || 0) * rate.in +
    Number(cacheWrite || 0) * rate.in * CACHE_WRITE_MULTIPLIER_5M +
    Number(cacheRead || 0) * rate.in * cacheReadMultiplierFor(model)
  ) / 1e6 + (Number(outTok || 0) * rate.out) / 1e6;
}

/**
 * Cache-aware cost rounded to cents. Byte-for-byte the behaviour the
 * admin metrics page has always had — kept exactly so extracting this
 * module changes no displayed number.
 */
function cacheCost(model, inTok, outTok, cacheWrite, cacheRead) {
  return Math.round(cacheCostRaw(model, inTok, outTok, cacheWrite, cacheRead) * 100) / 100;
}

/** Simple in/out cost, unrounded. For sources with no cache columns. */
function costForRaw(model, inTok, outTok) {
  return cacheCostRaw(model, inTok, outTok, 0, 0);
}

module.exports = {
  MODEL_COSTS,
  DEFAULT_MODEL_COST,
  CACHE_READ_MULTIPLIER,
  DEFAULT_CACHE_READ_MULTIPLIER,
  CACHE_WRITE_MULTIPLIER_5M,
  MANAGED_SESSION_RUNTIME_USD_PER_HOUR,
  cacheReadMultiplierFor,
  rateFor,
  cacheCost,
  cacheCostRaw,
  costForRaw,
};
