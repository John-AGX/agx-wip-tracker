// test/agent-prefix-ledger.test.js — a number narrower than its own label.
//
// /api/admin/agents/managed/prompt-audit published `first_turn_floor` under
// this note:
//
//     "This is what Anthropic caches on the registered agent. Every fresh
//      session pays this read on its first turn via cache_read."
//
// It was computed as composedSystem.total_chars + customToolsFor(agentKey),
// and nothing else. No skills. And the agent_toolset_20260401 entry counted
// as ZERO characters, though Anthropic expands that one entry into eight full
// tool schemas that ride in the cached prefix and are billed on every turn.
//
// It reported 12,715 tokens. The measured registered prefix on the same agent
// was 26,452, and the user was paying ~112k a turn. An instrument that
// under-reports by 2x against its own subject — and 9x against the bill —
// is worse than no instrument: it does not merely fail to help, it actively
// sends whoever reads it somewhere else to look.
//
// The defect is not arithmetic. It is publishing a total under a label wider
// than the total. So what is pinned here is the CONTRACT, not the arithmetic:
// a ledger may be incomplete, but it may not be incomplete and silent. There
// is no grand total unless the ledger is complete.

const {
  buildFirstTurnFloor, observedFromFirstTurns,
  builtinToolsetToolNames, AGENT_TOOLSET_20260401_TOOLS,
} = require('../server/services/agent-prefix-ledger');

const REAL_UNMEASURED = [
  { component: 'agent_toolset_20260401 — 8 built-in tool schemas',
    registered: true, why_not_measured: 'Anthropic expands the reference server-side.' },
  { component: '3 Anthropic Skills attached by skill_id',
    registered: true, why_not_measured: 'Descriptor text is Anthropic-side.' },
  { component: 'Anthropic managed-agent harness preamble',
    registered: true, why_not_measured: 'We never see that text.' },
];

// The live measured figures from the agent this was found on.
const LIVE = { composedSystemChars: 20382, customToolChars: 30479 };

describe('THE CONTRACT — no grand total unless the ledger is complete', () => {
  test('with unmeasured components there is NO grand_total_tokens field', () => {
    const f = buildFirstTurnFloor(Object.assign({}, LIVE, { unmeasured: REAL_UNMEASURED }));
    expect(f.complete).toBe(false);
    expect(f).not.toHaveProperty('grand_total_tokens');
    expect(f.why_no_grand_total).toBeTruthy();
  });

  test('the subtotal is named a SUBTOTAL, never a total', () => {
    const f = buildFirstTurnFloor(Object.assign({}, LIVE, { unmeasured: REAL_UNMEASURED }));
    expect(f).toHaveProperty('modeled_subtotal_tokens');
    expect(f.modeled_subtotal_tokens).toBe(5096 + 7620);
  });

  test('an empty ledger IS allowed a grand total — completeness is the gate', () => {
    const f = buildFirstTurnFloor(Object.assign({}, LIVE, { unmeasured: [] }));
    expect(f.complete).toBe(true);
    expect(f.grand_total_tokens).toBe(f.modeled_subtotal_tokens);
    expect(f).not.toHaveProperty('why_no_grand_total');
  });

  test('the gate holds for ANY number of unmeasured components', () => {
    for (let n = 0; n <= 6; n++) {
      const u = REAL_UNMEASURED.slice(0, 0).concat(
        Array.from({ length: n }, (_, i) => ({
          component: 'c' + i, registered: true, why_not_measured: 'because ' + i,
        })));
      const f = buildFirstTurnFloor(Object.assign({}, LIVE, { unmeasured: u }));
      expect(f.complete).toBe(n === 0);
      expect(Object.prototype.hasOwnProperty.call(f, 'grand_total_tokens')).toBe(n === 0);
    }
  });

  test('every unmeasured component must SAY WHY — a blank reason self-reports', () => {
    const f = buildFirstTurnFloor(Object.assign({}, LIVE, {
      unmeasured: [{ component: 'mystery', registered: true }],
    }));
    expect(f.unmeasured_components[0].why_not_measured).toMatch(/NOT STATED/);
    expect(f.unmeasured_components[0].why_not_measured).toMatch(/defect/);
  });

  test('the components it CANNOT weigh are still NAMED', () => {
    const f = buildFirstTurnFloor(Object.assign({}, LIVE, { unmeasured: REAL_UNMEASURED }));
    const names = f.unmeasured_components.map(c => c.component).join(' | ');
    expect(names).toMatch(/agent_toolset_20260401/);
    expect(names).toMatch(/Skills/);
    expect(names).toMatch(/harness/);
  });
});

describe('observed ground truth and the live size of the hole', () => {
  test('unexplained_tokens is observed minus modeled — self-calibrating', () => {
    const f = buildFirstTurnFloor(Object.assign({}, LIVE, {
      unmeasured: REAL_UNMEASURED,
      observed: { tokens: 26452, method: 'first turn of a fresh session' },
    }));
    expect(f.observed_first_turn_tokens).toBe(26452);
    expect(f.unexplained_tokens).toBe(26452 - 12716);
    // The residual measured by hand on the live agent was ~13,737.
    expect(f.unexplained_tokens).toBeGreaterThan(13000);
    expect(f.unexplained_tokens).toBeLessThan(14500);
  });

  test('with no observation it says the true size is UNKNOWN, not zero', () => {
    const f = buildFirstTurnFloor(Object.assign({}, LIVE, {
      unmeasured: REAL_UNMEASURED, observed: null,
    }));
    expect(f.observed_first_turn_tokens).toBeNull();
    expect(f.unexplained_tokens).toBeNull();
    expect(f.headline).toMatch(/UNKNOWN/);
    expect(f.headline).toMatch(/floor under it, not an estimate/);
  });

  test('the note says the prefix is NOT the cost of a turn', () => {
    // Reading the floor as "what a turn costs" is what made a 112k turn look
    // like a 12.7k one. History is added on top and is unbounded.
    const f = buildFirstTurnFloor(Object.assign({}, LIVE, { unmeasured: REAL_UNMEASURED }));
    expect(f.what_this_is).toMatch(/NOT the cost of a turn/);
    expect(f.what_this_is).toMatch(/session history/i);
  });
});

describe('observedFromFirstTurns — a first turn IS the prefix', () => {
  test('warm agent: cache_read carries it', () => {
    const o = observedFromFirstTurns([{ session_id: 227, cc: 1210, cr: 26452 }]);
    expect(o.tokens).toBe(27662);
  });

  test('cold agent: cache_creation carries it, cache_read null', () => {
    const o = observedFromFirstTurns([{ session_id: 204, cc: 27278, cr: null }]);
    expect(o.tokens).toBe(27278);
  });

  test('the two paths agree within a couple of percent', () => {
    const warm = observedFromFirstTurns([{ session_id: 227, cc: 1210, cr: 26452 }]).tokens;
    const cold = observedFromFirstTurns([{ session_id: 204, cc: 27278, cr: null }]).tokens;
    expect(Math.abs(warm - cold) / cold).toBeLessThan(0.02);
  });

  test('it reports HOW it measured, and on which session', () => {
    const o = observedFromFirstTurns([
      { session_id: 227, cc: 1210, cr: 26452, anthropic_session_id: 'sesn_x' },
    ]);
    expect(o.method).toMatch(/first assistant turn/i);
    expect(o.sample.session_id).toBe(227);
    expect(o.sample.anthropic_session_id).toBe('sesn_x');
  });

  test('no rows, empty rows, or all-zero rows yield null — never a fake zero', () => {
    expect(observedFromFirstTurns([])).toBeNull();
    expect(observedFromFirstTurns(null)).toBeNull();
    expect(observedFromFirstTurns([{ session_id: 1, cc: 0, cr: 0 }])).toBeNull();
  });
});

describe('builtinToolsetToolNames — naming the eight schemas the audit cannot weigh', () => {
  test("86's config (default_config.enabled=true) turns on all eight", () => {
    const names = builtinToolsetToolNames([
      { type: 'agent_toolset_20260401', default_config: { enabled: true } },
    ]);
    expect(names).toEqual(AGENT_TOOLSET_20260401_TOOLS);
    expect(names).toHaveLength(8);
  });

  test("the Assistant's surgical web-only config turns on exactly two", () => {
    const names = builtinToolsetToolNames([{
      type: 'agent_toolset_20260401',
      default_config: { enabled: false },
      configs: [{ name: 'web_search', enabled: true }, { name: 'web_fetch', enabled: true }],
    }]);
    expect(names.sort()).toEqual(['web_fetch', 'web_search']);
  });

  test('the Scribe has no toolset at all', () => {
    expect(builtinToolsetToolNames([])).toEqual([]);
    expect(builtinToolsetToolNames(null)).toEqual([]);
  });

  test('an explicit per-tool disable is honoured over an enabled default', () => {
    const names = builtinToolsetToolNames([{
      type: 'agent_toolset_20260401',
      default_config: { enabled: true },
      configs: [{ name: 'bash', enabled: false }],
    }]);
    expect(names).not.toContain('bash');
    expect(names).toContain('read');
  });

  test('an unknown toolset type is not silently counted as eight tools', () => {
    expect(builtinToolsetToolNames([{ type: 'agent_toolset_29991231' }])).toEqual([]);
  });
});

// ── Mutation guard ────────────────────────────────────────────────────────
describe('the contract detects its own bypasses', () => {
  // The pre-fix builder, reproduced exactly.
  function legacyFloor(composedChars, toolChars) {
    return {
      note: 'This is what Anthropic caches on the registered agent. Every fresh session ' +
            'pays this read on its first turn via cache_read.',
      grand_total_tokens: Math.round((composedChars + toolChars) / 4),
    };
  }

  test('RED — the old builder publishes a complete-looking total that is 2x low', () => {
    const old = legacyFloor(LIVE.composedSystemChars, LIVE.customToolChars);
    expect(old.grand_total_tokens).toBe(12715);
    // It claims to be the registered prefix…
    expect(old.note).toMatch(/what Anthropic caches on the registered agent/);
    // …and it is not within 50% of the measured 26,452.
    expect(old.grand_total_tokens / 26452).toBeLessThan(0.5);
    // And nothing in it admits an omission.
    expect(old).not.toHaveProperty('unmeasured_components');
  });

  test('GREEN — the new builder refuses the total and sizes the hole instead', () => {
    const f = buildFirstTurnFloor(Object.assign({}, LIVE, {
      unmeasured: REAL_UNMEASURED,
      observed: { tokens: 26452, method: 'm' },
    }));
    expect(f).not.toHaveProperty('grand_total_tokens');
    expect(f.observed_first_turn_tokens).toBe(26452);
    expect(f.unexplained_tokens).toBeGreaterThan(0);
  });

  test('RED — declaring components but still emitting a total breaks the gate', () => {
    // A "helpful" future edit that adds the disclosure list AND keeps the
    // total is still the original defect: readers take the total.
    const bypass = Object.assign(
      buildFirstTurnFloor(Object.assign({}, LIVE, { unmeasured: REAL_UNMEASURED })),
      { grand_total_tokens: 12715 }
    );
    expect(bypass.complete).toBe(false);
    expect(bypass).toHaveProperty('grand_total_tokens'); // the bypass…
    // …which the contract forbids: complete === false must mean no total.
    const honest = buildFirstTurnFloor(Object.assign({}, LIVE, { unmeasured: REAL_UNMEASURED }));
    expect(honest.complete === false && !('grand_total_tokens' in honest)).toBe(true);
  });
});
