'use strict';

/**
 * agent-prefix-ledger.js — the honesty contract for the prompt-audit ledger.
 *
 * WHY THIS FILE EXISTS
 *
 * /api/admin/agents/managed/prompt-audit reported a field called
 * `first_turn_floor` whose own note read:
 *
 *     "This is what Anthropic caches on the registered agent. Every fresh
 *      session pays this read on its first turn via cache_read."
 *
 * It was computed as composedSystem.total_chars + customToolsFor(agentKey) —
 * and nothing else. It counted no skills, and it counted the
 * agent_toolset_20260401 entry as zero characters even though that one entry
 * expands server-side into eight full tool schemas that are billed on every
 * turn. It reported 12,715 tokens. The measured registered prefix on the same
 * agent was 26,452. A measuring instrument that under-reports by 2x — and by
 * 9x against the number the user was actually paying — is worse than no
 * instrument, because it sends whoever reads it to look somewhere else.
 *
 * The defect is not arithmetic. It is that a number was published under a
 * label WIDER than the number. This codebase keeps repeating that shape.
 *
 * THE CONTRACT
 *
 * A ledger may be incomplete. It may NOT be incomplete and silent about it.
 * So:
 *
 *   • Everything measured server-side goes in `modeled`, and its sum is named
 *     `modeled_subtotal_tokens` — a SUBTOTAL, never a total.
 *   • Everything registered but not measurable here goes in
 *     `unmeasured_components`, each entry carrying a non-empty
 *     `why_not_measured`.
 *   • `grand_total_tokens` EXISTS ONLY WHEN `complete` IS TRUE. There is no
 *     such thing here as a total with a hole in it. A reader who greps for
 *     the total either gets a real one or gets nothing to misread.
 *   • `observed_first_turn_tokens` carries ground truth measured from our own
 *     turn records, and `unexplained_tokens` is observed minus modeled — the
 *     live size of the hole, self-calibrating, no constant to go stale.
 */

function _tok(chars) { return Math.round(Number(chars || 0) / 4); }

/**
 * @param {object} a
 * @param {number} a.composedSystemChars   registered system prompt, chars
 * @param {number} a.customToolChars       custom tool schemas, chars
 * @param {Array}  a.unmeasured            [{component, why_not_measured, registered, tokens?}]
 * @param {object|null} a.observed         {tokens, method, ...} or null
 */
function buildFirstTurnFloor(a) {
  const modeled = {
    composed_system_tokens: _tok(a.composedSystemChars),
    custom_tool_schema_tokens: _tok(a.customToolChars),
  };
  const modeledSubtotal = modeled.composed_system_tokens + modeled.custom_tool_schema_tokens;

  // An entry with no stated reason is not a disclosure, it is a shrug. Reject
  // it loudly rather than let it dilute the contract.
  const unmeasured = (Array.isArray(a.unmeasured) ? a.unmeasured : []).map(function (u) {
    return {
      component: String((u && u.component) || '(unnamed)'),
      registered: !!(u && u.registered),
      tokens: (u && Number.isFinite(u.tokens)) ? u.tokens : null,
      why_not_measured: String((u && u.why_not_measured) || '') ||
        'NOT STATED — this entry is a defect; every unmeasured component must say why.',
    };
  });

  const complete = unmeasured.length === 0;
  const observed = (a.observed && Number.isFinite(a.observed.tokens)) ? a.observed : null;

  const out = {
    what_this_is:
      'The tokens Anthropic caches on the REGISTERED AGENT — read via cache_read on the ' +
      'first turn of every fresh session, and re-written as cache_creation whenever that ' +
      'cache entry lapses. It is NOT the cost of a turn: session history is added on top ' +
      'of it and grows without bound (see session_history).',
    complete: complete,
    modeled: modeled,
    modeled_subtotal_tokens: modeledSubtotal,
    unmeasured_components: unmeasured,
    observed_first_turn_tokens: observed ? observed.tokens : null,
    observed_method: observed ? observed.method : null,
    observed_sample: observed ? (observed.sample || null) : null,
    unexplained_tokens: observed ? (observed.tokens - modeledSubtotal) : null,
  };

  if (complete) {
    // Only here is a total honest.
    out.grand_total_tokens = modeledSubtotal;
  } else {
    out.why_no_grand_total =
      'No grand total is reported because ' + unmeasured.length + ' registered component(s) ' +
      'cannot be measured server-side (listed in unmeasured_components). A total that ' +
      'silently omits them would be narrower than its own label — the exact defect this ' +
      'endpoint used to have when it reported ' + modeledSubtotal + ' as the floor. Use ' +
      'observed_first_turn_tokens for ground truth.';
  }

  if (observed) {
    out.headline =
      'Modeled ' + modeledSubtotal + ' tok from ' + Object.keys(modeled).length +
      ' measured parts; MEASURED ' + observed.tokens + ' tok on a real first turn. ' +
      out.unexplained_tokens + ' tok is the live size of what this endpoint cannot see ' +
      '(built-in toolset schemas, skill descriptors, Anthropic harness preamble).';
  } else {
    out.headline =
      'Modeled ' + modeledSubtotal + ' tok. NO observed first turn is available for this ' +
      'agent, so the true registered size is UNKNOWN — the modeled subtotal is a floor ' +
      'under it, not an estimate of it.';
  }

  return out;
}

/**
 * The observed prefix, derived from one real cold-start turn.
 *
 * A session's FIRST assistant turn has no conversation history behind it, so
 * everything it reads or writes to cache IS the registered agent prefix:
 *   • warm agent  → cache_read carries the prefix, cache_creation is the
 *                   turn's own small delta
 *   • cold agent  → cache_creation carries the whole thing, cache_read is null
 * Summing the two covers both without branching, and the two agree to ~1.4%
 * on the sessions this was validated against.
 *
 * @param {Array} rows [{session_id, cc, cr, created_at, anthropic_session_id}]
 */
function observedFromFirstTurns(rows) {
  const list = (Array.isArray(rows) ? rows : []).filter(function (r) {
    return r && (Number.isFinite(Number(r.cc)) || Number.isFinite(Number(r.cr)));
  });
  if (!list.length) return null;
  const r = list[0];
  const cc = Number(r.cc || 0);
  const cr = Number(r.cr || 0);
  const tokens = cc + cr;
  if (!tokens) return null;
  return {
    tokens: tokens,
    method:
      'cache_creation + cache_read on the FIRST assistant turn of session ' + r.session_id +
      '. A first turn has no history behind it, so everything it reads or writes to cache ' +
      'IS the registered agent prefix (warm agent → it lands in cache_read; cold agent → ' +
      'in cache_creation; summing covers both).',
    sample: {
      session_id: r.session_id,
      anthropic_session_id: r.anthropic_session_id || null,
      turn_at: r.created_at || null,
      cache_creation_tokens: cc,
      cache_read_tokens: cr,
    },
  };
}

/**
 * The tools agent_toolset_20260401 actually turns on for a given toolset
 * config. We register a ~90-char REFERENCE; Anthropic expands it into this
 * many full tool schemas inside the cached prefix, billed on every turn.
 *
 * prompt-audit counted that reference as ZERO chars and called the result
 * "what Anthropic caches on the registered agent". This exists so the audit
 * can at least NAME what it cannot weigh — and so that the day a toolset
 * version adds a ninth tool, the list here is the thing that goes stale
 * visibly rather than a total that goes wrong quietly.
 */
const AGENT_TOOLSET_20260401_TOOLS = [
  'bash', 'read', 'write', 'edit', 'glob', 'grep', 'web_search', 'web_fetch'
];

function builtinToolsetToolNames(entries) {
  const out = [];
  for (const e of (Array.isArray(entries) ? entries : [])) {
    if (!e || e.type !== 'agent_toolset_20260401') continue;
    const defaultOn = !(e.default_config && e.default_config.enabled === false);
    const overrides = new Map();
    for (const c of (Array.isArray(e.configs) ? e.configs : [])) {
      if (c && c.name) overrides.set(c.name, c.enabled !== false);
    }
    for (const name of AGENT_TOOLSET_20260401_TOOLS) {
      const on = overrides.has(name) ? overrides.get(name) : defaultOn;
      if (on && out.indexOf(name) === -1) out.push(name);
    }
  }
  return out;
}

module.exports = {
  buildFirstTurnFloor,
  observedFromFirstTurns,
  builtinToolsetToolNames,
  AGENT_TOOLSET_20260401_TOOLS,
};
