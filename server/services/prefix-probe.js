'use strict';

/**
 * prefix-probe.js — measures the part of a managed agent's CACHED PREFIX that
 * no server-side ledger can see, by bisection against real sessions.
 *
 * WHY THIS FILE EXISTS
 *
 * services/agent-prefix-ledger.js reports what we can model and refuses to
 * publish a grand total because three registered components are invisible
 * from here. On 86 the numbers are: 67,100 tokens OBSERVED on a real first
 * turn, 15,640 modelled (6,746 composed system + 8,894 custom tool schemas),
 * and ~51,460 unaccounted — the expanded `agent_toolset_20260401` schemas,
 * the attached Skills' descriptors, and Anthropic's own harness preamble.
 * The ledger names that gap honestly; it cannot close it.
 *
 * That gap is 77% of the prefix, and the prefix is paid on the first turn of
 * EVERY session and re-paid as cache_creation whenever the entry lapses. The
 * one lever available on Managed Agents for any of it is the partial toolset
 * (default_config.enabled:false plus per-tool configs) — which this codebase
 * already applies to the `assistant` agent, where a comment estimates the
 * full toolset at "~30k cached tokens of dead weight". That estimate has
 * never been measured. Deciding 86's toolset off an unmeasured ~30k is
 * exactly the habit the ledger was written to stop.
 *
 * HOW IT MEASURES
 *
 * A fresh session's FIRST turn has no history behind it, so everything it
 * reads or writes to cache IS the registered prefix (cold → cache_creation,
 * warm → cache_read; summing covers both). So: register a throwaway agent
 * with a KNOWN subset of the components, run one trivial turn, and read
 * span.model_request_end.model_usage. Each component's size is then the
 * DIFFERENCE between two sets that differ only by that component.
 *
 * WHAT A DELTA DOES AND DOES NOT COST
 *
 * Every set pays the same trivial user message and the same short reply, so
 * that overhead CANCELS in every delta. It does not cancel in the floor set,
 * which is therefore labelled "harness preamble + this probe's own message"
 * rather than "harness preamble" — a floor that claimed to be the preamble
 * alone would be the same over-claiming defect in a new place.
 *
 * WHY ONE AGENT AND NOT SEVEN
 *
 * @anthropic-ai/sdk 0.94.0 exposes create / retrieve / update / list on
 * beta.agents — there is NO delete. Seven throwaway agents would be seven
 * permanent rows in the account. So the probe creates ONE agent and UPDATEs
 * it through the sets; each update mints a version and each session pins the
 * version current when it was created. Cleanup then ATTEMPTS a raw
 * DELETE /v1/agents/{id} (the SDK has a generic .delete) and REPORTS the
 * outcome either way. A probe that silently failed to clean up would leave
 * the account dirty and say nothing.
 */

// The toolset entry 86 registers today: everything enabled.
const TOOLSET_FULL = { type: 'agent_toolset_20260401', default_config: { enabled: true } };

// A toolset entry with only the named members enabled.
function toolsetWith(names) {
  return {
    type: 'agent_toolset_20260401',
    default_config: { enabled: false },
    configs: names.map((name) => ({ name, enabled: true })),
  };
}

/**
 * THE SETS. Each one names what it includes; the deltas below say which pair
 * measures which component. Order matters only for reporting.
 *
 * `needs` lists the live parts a set pulls in (system / customTools / skills),
 * resolved by the caller so this module stays free of the registry and the
 * SDK. `toolset` is the builtin entry or null.
 */
const PROBE_SETS = [
  {
    key: 'floor',
    label: 'harness preamble + this probe\'s own message',
    includes: [],
    toolset: null,
  },
  {
    key: 'system',
    label: 'floor + 86\'s composed system prompt',
    includes: ['system'],
    toolset: null,
  },
  {
    key: 'custom_tools',
    label: 'floor + the 33 custom tool schemas',
    includes: ['customTools'],
    toolset: null,
  },
  {
    key: 'toolset_full',
    label: 'floor + the FULL builtin toolset (what 86 registers today)',
    includes: [],
    toolset: TOOLSET_FULL,
  },
  {
    key: 'toolset_read',
    label: 'floor + builtin toolset: read only (the minimum Skills require)',
    includes: [],
    toolset: toolsetWith(['read']),
  },
  {
    key: 'toolset_read_web',
    label: 'floor + builtin toolset: read + glob + grep + web_search + web_fetch (a lean 86 that keeps Skills and research)',
    includes: [],
    toolset: toolsetWith(['read', 'glob', 'grep', 'web_search', 'web_fetch']),
  },
  {
    key: 'skills',
    label: 'floor + the 3 attached Skills (needs read: a skill with no read is a 400)',
    includes: ['skills'],
    toolset: toolsetWith(['read']),
  },
  {
    key: 'replica',
    label: 'everything 86 registers — validates the method against the observed prefix',
    includes: ['system', 'customTools', 'skills'],
    toolset: TOOLSET_FULL,
  },
];

/**
 * Build the beta.agents.create|update payload for one set.
 *
 * `parts` supplies the live pieces: { system, customTools, skills, model, name }.
 * A set that includes nothing still needs a model and a name, and `system` is
 * sent as SYSTEM_PLACEHOLDER rather than omitted so every set has the same
 * shape (an absent field and an empty one are not reliably the same thing
 * across an API version bump, and the floor must not accidentally measure that
 * difference).
 */
// The smallest system the API will take. A single space — the obvious
// placeholder, and the one the first live run used — comes back as
// 400 "system: text content blocks must contain non-whitespace text" and cost
// six of eight sets. One character of real text is the floor, and because
// EVERY non-system set carries the same one, it cancels out of every delta.
const SYSTEM_PLACEHOLDER = 'x';

function buildProbePayload(set, parts) {
  if (!set) throw new Error('prefix-probe: a set is required');
  if (!parts || !parts.model) throw new Error('prefix-probe: parts.model is required');
  const inc = (what) => (set.includes || []).indexOf(what) !== -1;
  const tools = [];
  if (set.toolset) tools.push(set.toolset);
  if (inc('customTools')) tools.push(...(parts.customTools || []));
  const skills = inc('skills') ? (parts.skills || []) : [];
  return {
    model: parts.model,
    name: parts.name || 'P86 prefix probe',
    description: 'Throwaway agent for prefix measurement. Safe to delete.',
    system: inc('system') ? (parts.system || SYSTEM_PLACEHOLDER) : SYSTEM_PLACEHOLDER,
    skills: skills,
    tools: tools,
  };
}

/**
 * The component table. Each row is a DIFFERENCE between two measured sets,
 * named with the pair it came from so a reader can re-derive it. A row whose
 * two sets were not both measured is reported as unavailable rather than
 * silently dropped — half a bisection is not a measurement.
 */
const COMPONENT_DELTAS = [
  { component: 'composed system prompt', minus: 'system', base: 'floor', compare_to_modelled: 'composed_system_tokens' },
  { component: 'custom tool schemas', minus: 'custom_tools', base: 'floor', compare_to_modelled: 'custom_tool_schema_tokens' },
  { component: 'builtin toolset — ALL 8 tools', minus: 'toolset_full', base: 'floor', compare_to_modelled: null },
  { component: 'builtin toolset — read only', minus: 'toolset_read', base: 'floor', compare_to_modelled: null },
  { component: 'builtin toolset — read+glob+grep+web', minus: 'toolset_read_web', base: 'floor', compare_to_modelled: null },
  { component: '3 Skills descriptors', minus: 'skills', base: 'toolset_read', compare_to_modelled: null },
];

const n = (v) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

/**
 * The CACHED part of what a first turn read: cold lands in cache_creation,
 * warm in cache_read. This is the measure agent-prefix-ledger uses, and on a
 * small agent it reads ZERO — prompt caching has a 1,024-token minimum, so a
 * floor agent with a one-character system and no tools is never cached at
 * all. The first complete probe run measured the floor at 0 this way while
 * the same turn plainly consumed input, which makes every delta built on it
 * meaningless.
 */
function prefixTokensOf(measurement) {
  if (!measurement || measurement.error) return null;
  return n(measurement.cache_creation_input_tokens) + n(measurement.cache_read_input_tokens);
}

/**
 * TOTAL INPUT: uncached + cache writes + cache reads. This is what a set
 * actually costs to send, whether or not the platform chose to cache it, and
 * it is therefore the only apples-to-apples basis for a difference between
 * two sets. Components are derived from this; prefixTokensOf rides alongside
 * so the two can be compared rather than conflated.
 */
function totalInputOf(measurement) {
  if (!measurement || measurement.error) return null;
  return n(measurement.input_tokens) + n(measurement.cache_creation_input_tokens)
    + n(measurement.cache_read_input_tokens);
}

/**
 * Turn raw per-set measurements into the report.
 *
 * @param {object} measurements  { [setKey]: { cache_creation_input_tokens, cache_read_input_tokens, input_tokens, output_tokens, model_requests, error? } }
 * @param {object} modelled      the prompt-audit's modelled parts, for comparison
 * @param {number} observedPrefix  the prefix observed on a REAL 86 session, if known
 */
function buildProbeReport(measurements, modelled, observedPrefix) {
  const m = measurements || {};
  const sets = PROBE_SETS.map((s) => {
    const raw = m[s.key];
    return {
      set: s.key,
      label: s.label,
      total_input_tokens: totalInputOf(raw),
      cached_tokens: prefixTokensOf(raw),
      uncached_tokens: raw && !raw.error ? n(raw.input_tokens) : null,
      measured: !!(raw && !raw.error),
      error: (raw && raw.error) || null,
      model_requests: raw ? n(raw.model_requests) : null,
    };
  });
  const byKey = {};
  for (const s of sets) byKey[s.set] = s;

  const components = COMPONENT_DELTAS.map((d) => {
    const hi = byKey[d.minus];
    const lo = byKey[d.base];
    const ok = !!(hi && lo && hi.measured && lo.measured);
    const row = {
      component: d.component,
      derived_from: d.minus + ' − ' + d.base,
      tokens: ok ? (hi.total_input_tokens - lo.total_input_tokens) : null,
      measured: ok,
    };
    if (!ok) {
      row.why_unavailable = !hi || !hi.measured
        ? 'set "' + d.minus + '" was not measured' + (hi && hi.error ? ': ' + hi.error : '')
        : 'set "' + d.base + '" was not measured' + (lo && lo.error ? ': ' + lo.error : '');
    }
    if (d.compare_to_modelled && modelled && modelled[d.compare_to_modelled] != null) {
      row.server_modelled_tokens = n(modelled[d.compare_to_modelled]);
      if (ok) row.measured_minus_modelled = row.tokens - row.server_modelled_tokens;
    }
    return row;
  });

  const floor = byKey.floor;
  const replica = byKey.replica;
  const report = {
    sets: sets,
    components: components,
    // The floor is NOT "the harness preamble": it also contains this probe's
    // own user message and the model's reply. Named for what it is.
    floor_tokens: floor && floor.measured ? floor.total_input_tokens : null,
    floor_is: PROBE_SETS[0].label,
  };

  // The method's own check: a replica of 86 should land near the prefix a real
  // 86 session was observed to pay. If it does not, the deltas above are
  // measuring something other than what they are labelled.
  if (replica && replica.measured && observedPrefix) {
    report.method_check = {
      replica_tokens: replica.total_input_tokens,
      observed_on_real_agent: n(observedPrefix),
      difference: replica.total_input_tokens - n(observedPrefix),
      note: 'A replica carries the same components but a different name, description and version, '
        + 'and the real agent may also hold MCP servers. A small difference is expected; a large '
        + 'one means the component labels above are wrong.',
    };
  }

  // What is still not attributed, stated as a residual rather than folded
  // into a component. With the full toolset measured, the remainder of the
  // replica is the harness preamble and anything this probe did not vary.
  const measuredParts = ['composed system prompt', 'custom tool schemas', 'builtin toolset — ALL 8 tools', '3 Skills descriptors']
    .map((name) => components.find((c) => c.component === name))
    .filter((c) => c && c.measured);
  if (replica && replica.measured && measuredParts.length === 4) {
    const attributed = measuredParts.reduce((a, c) => a + c.tokens, 0);
    report.residual = {
      tokens: replica.total_input_tokens - attributed,
      what_it_is: 'the replica prefix minus every component measured above — Anthropic\'s harness '
        + 'preamble plus this probe\'s own message, i.e. the floor, if the method is sound',
      floor_tokens: report.floor_tokens,
      agrees_with_floor: report.floor_tokens != null
        ? Math.abs((replica.total_input_tokens - attributed) - report.floor_tokens) : null,
    };
  }

  report.complete = components.every((c) => c.measured)
    && !!(floor && floor.measured) && !!(replica && replica.measured);
  if (!report.complete) {
    report.why_incomplete = 'One or more sets did not measure; see sets[].error and '
      + 'components[].why_unavailable. No component total is published from a partial run.';
  }
  return report;
}

module.exports = {
  PROBE_SETS,
  totalInputOf,
  SYSTEM_PLACEHOLDER,
  COMPONENT_DELTAS,
  TOOLSET_FULL,
  toolsetWith,
  buildProbePayload,
  prefixTokensOf,
  buildProbeReport,
};
