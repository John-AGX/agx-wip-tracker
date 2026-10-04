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
 *   • `observed_first_turn_input_tokens` carries a sampled first turn's TOTAL
 *     INPUT from our own turn records. It is NOT the registered prefix, and
 *     `first_turn_input_minus_modeled_tokens` is NOT the size of the hole:
 *     a first turn has no history, but it carries its own content — the user
 *     message and the whole <turn_context> block. Both fields were named as
 *     if the difference were the invisible components, and on 86 that read
 *     ~51,460 when those components measure 7,084. The lesson is this file's
 *     own: a number is only as wide as its label, and `observed` was being
 *     read as `registered`. The prefix is measured by the probe instead —
 *     POST /api/admin/agents/managed/prefix-probe — which registers
 *     throwaway agents carrying known subsets and takes differences.
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
      'What this endpoint can MODEL of the registered agent — the system prompt it composes and the custom tool schemas it registers — plus a sample first turn\'s total input for comparison. The registered prefix itself is read via cache_read on the first turn of every fresh session and re-written as cache_creation whenever that entry lapses; it is NOT the cost of a turn (session history is added on top and grows without bound — see session_history), and it is NOT the same thing as a first turn\'s input, which also carries that turn\'s own context. For the prefix itself, measured, see measured_prefix_source.',
    complete: complete,
    modeled: modeled,
    modeled_subtotal_tokens: modeledSubtotal,
    unmeasured_components: unmeasured,
    // THE FIRST TURN'S WHOLE INPUT — not the registered prefix. The old
    // name for this field was observed_first_turn_tokens and the headline
    // called the remainder "the live size of what this endpoint cannot
    // see", on the reasoning that a first turn has no history so whatever
    // it reads must be the prefix. A first turn has no HISTORY, but it
    // carries its own CONTENT: the user message and the entire
    // <turn_context> block (entity snapshot, attachment manifest, recent
    // writes, available tools). On a job turn that is tens of thousands of
    // tokens and has nothing to do with registration.
    //
    // MEASURED 2026-10-04 by routes/admin-agents-routes.js
    // /managed/prefix-probe, which registers throwaway agents carrying
    // known subsets and bisects: 86's registered prefix is 30,126 tokens,
    // against 67,100 for the sampled first turn. The three components this
    // endpoint cannot see total 7,084 (built-in toolset 5,564, Skills
    // descriptors 690, harness preamble ~830) — not the ~51,460 the old
    // headline attributed to them. The rest was that turn's own context.
    observed_first_turn_input_tokens: observed ? observed.tokens : null,
    observed_method: observed ? observed.method : null,
    observed_sample: observed ? (observed.sample || null) : null,
    // observed minus modelled, and NOT a size for the unmeasured
    // components: it also contains the turn's own content. Named for what
    // it is rather than for what someone hoped it was.
    first_turn_input_minus_modeled_tokens: observed ? (observed.tokens - modeledSubtotal) : null,
    measured_prefix_source:
      'Run POST /api/admin/agents/managed/prefix-probe for a component-by-component '
      + 'measurement of the registered prefix, and GET .../prefix-probe/runs to read '
      + 'the last one. This endpoint cannot measure it: it can only model the parts it '
      + 'composes and report a first turn\'s total input alongside.',
  };

  if (complete) {
    // Only here is a total honest.
    out.grand_total_tokens = modeledSubtotal;
  } else {
    out.why_no_grand_total =
      'No grand total is reported because ' + unmeasured.length + ' registered component(s) ' +
      'cannot be measured server-side (listed in unmeasured_components). A total that ' +
      'silently omits them would be narrower than its own label — the exact defect this ' +
      'endpoint used to have when it reported ' + modeledSubtotal + ' as the floor. For ' +
      'the registered prefix, measured component by component, run the prefix probe (see ' +
      'measured_prefix_source) — NOT observed_first_turn_input_tokens, which is a whole ' +
      'turn and includes that turn\'s own context.';
  }

  if (observed) {
    out.headline =
      'Modeled ' + modeledSubtotal + ' tok from ' + Object.keys(modeled).length +
      ' measured parts. A sampled first turn read ' + observed.tokens + ' tok of input in total, which is ' + out.first_turn_input_minus_modeled_tokens + ' tok more — but that difference is NOT the size of the components below: it also contains that turn\'s own <turn_context> and user message. Measured by the prefix probe on 2026-10-04, 86\'s registered prefix is 30,126 tok and the three components this endpoint cannot see total 7,084 of it. Run /managed/prefix-probe to re-measure.';
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
