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

// IMPORTANT: keep in lock-step with the live default model in
// ai-routes.js (process.env.AI_MODEL || 'claude-opus-4-8').
const MODEL_COSTS = {
  'claude-opus-4-8':   { in: 5,    out: 25  },
  'claude-opus-4-7':   { in: 5,    out: 25  },
  'claude-opus-4-6':   { in: 5,    out: 25  },
  'claude-opus-4-5':   { in: 15,   out: 75  },
  'claude-sonnet-4-6': { in: 3,    out: 15  },
  'claude-sonnet-4-5': { in: 3,    out: 15  },
  'claude-haiku-4-5':  { in: 1,    out: 5   }
};

// Fallback for any model not in the table. Mirrors the current Opus tier
// so a newer model rev never makes cost metrics silently collapse to $0 —
// the bug that hid all opus-4-8 spend until 2026-05. Conservative on the
// high side by design: an estimated number beats a missing one, and for
// an alarm, over-reporting fails toward noticing.
const DEFAULT_MODEL_COST = { in: 5, out: 25 };

function rateFor(model) {
  return MODEL_COSTS[model] || DEFAULT_MODEL_COST;
}

/**
 * Cache-aware cost in USD, unrounded.
 *
 * Cache writes bill at 1.25× the input rate, cache reads at 0.10×.
 * Unrounded because a caller summing many rows wants to round ONCE at the
 * end — rounding each row to cents first and then adding compounds the
 * error in whichever direction the rows happen to fall.
 */
function cacheCostRaw(model, inTok, outTok, cacheWrite, cacheRead) {
  const rate = rateFor(model);
  return (
    Number(inTok || 0) * rate.in +
    Number(cacheWrite || 0) * rate.in * 1.25 +
    Number(cacheRead || 0) * rate.in * 0.10
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
  rateFor,
  cacheCost,
  cacheCostRaw,
  costForRaw,
};
