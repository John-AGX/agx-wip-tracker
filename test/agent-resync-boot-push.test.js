// test/agent-resync-boot-push.test.js — the throttle that could not fire on
// the event that happens most.
//
// resyncDriftedAgents throttles pushes to the Anthropic agent, because every
// beta.agents.update mints a new immutable agent version (it does so even
// when the fields you send already equal the stored values), and a new
// version means every session on that agent pays a full cache_creation on the
// entire registered prefix instead of a cheap cache_read.
//
// The throttle lived entirely inside `if (!force && prev)`. `prev` came from
// _lastSyncState — a process-local Map. A Map is empty at boot. So on every
// process start, for every agent, `prev` was undefined, every guard was
// skipped, and control fell straight through to agents.update — unconditional,
// whether or not one byte had changed. Every Railway deploy restarts the
// process. The live 86 agent was on version 487 in 97 days: ~5/day, which is
// exactly the deploy cadence of this repo.
//
// The measured cost sat in plain sight: cache_creation of 148,260 in a single
// hour across 6 turns, on a prefix that is supposed to be written once.
//
// The fix persists the fingerprint to managed_agent_registry so the boot tick
// can ask the question the code never asked: did anything actually change?
// These tests pin that question's answers — including that a real change at
// boot STILL lands immediately, because "deploy new code and have it take
// effect" is the legitimate half of what the boot bypass was doing.

const {
  decideResync, MIN_RESYNC_INTERVAL_MS, MIN_DRIFT_RATIO,
} = require('../server/services/agent-resync-decision');

const NOW = 1_700_000_000_000;
const SYS = 'sha-system-aaa';
const TOOLS = 'sha-tools-bbb';
const CHARS = 20382;

function base(over) {
  return Object.assign({
    force: false, prev: null, sysHash: SYS, toolsHash: TOOLS,
    composedChars: CHARS, now: NOW,
  }, over || {});
}
// A fingerprint recovered from the registry row at boot.
function fromDisk(over) {
  return Object.assign({
    sysHash: SYS, toolsHash: TOOLS, toolsOk: true,
    syncedAt: NOW - 60 * 60 * 1000, size: CHARS, fromDisk: true,
  }, over || {});
}
// A fingerprint written by this process earlier.
function inProcess(over) {
  return Object.assign({
    sysHash: SYS, toolsHash: TOOLS, toolsOk: true,
    syncedAt: NOW - 60 * 60 * 1000, size: CHARS, fromDisk: false,
  }, over || {});
}

describe('THE DEFECT — an unchanged agent must not be re-registered at boot', () => {
  test('boot + nothing changed = NO push (this is the whole bug)', () => {
    const d = decideResync(base({ prev: fromDisk() }));
    expect(d.push).toBe(false);
    expect(d.reason).toMatch(/identical/);
  });

  test('the OLD behaviour — no prior state at all — still pushes', () => {
    // This is what every boot looked like before the fingerprint was
    // persisted: prev undefined, therefore push, unconditionally.
    expect(decideResync(base({ prev: null })).push).toBe(true);
  });

  test('N consecutive deploys with no content change cost ZERO pushes', () => {
    // Five restarts a day was the measured cadence. None of them should
    // register anything.
    let pushes = 0;
    for (let i = 0; i < 20; i++) {
      const d = decideResync(base({ prev: fromDisk(), now: NOW + i * 3600_000 }));
      if (d.push) pushes++;
    }
    expect(pushes).toBe(0);
  });
});

describe('a real change still lands immediately at boot', () => {
  test('a changed system prompt at boot pushes NOW, not in six hours', () => {
    const d = decideResync(base({
      prev: fromDisk({ sysHash: 'sha-system-OLD', size: CHARS - 5000 }),
    }));
    expect(d.push).toBe(true);
    expect(d.reason).toMatch(/boot/);
  });

  test('a changed tool list at boot pushes NOW', () => {
    const d = decideResync(base({ prev: fromDisk({ toolsHash: 'sha-tools-OLD' }) }));
    expect(d.push).toBe(true);
  });

  test('a boot change is NOT suppressed by the 6-hour throttle', () => {
    // Last push one minute ago, then a deploy that changed the baseline.
    const d = decideResync(base({
      prev: fromDisk({ sysHash: 'sha-system-OLD', size: 1, syncedAt: NOW - 60_000 }),
    }));
    expect(d.push).toBe(true);
  });

  test('a failed prior tools push is retried at boot', () => {
    const d = decideResync(base({ prev: fromDisk({ toolsOk: false }) }));
    expect(d.push).toBe(true);
  });
});

describe('steady-state rules are unchanged', () => {
  test('identical in-process = skip', () => {
    expect(decideResync(base({ prev: inProcess() })).push).toBe(false);
  });

  test('changed but inside 6 hours = throttled', () => {
    const d = decideResync(base({
      prev: inProcess({ sysHash: 'other', size: 1, syncedAt: NOW - 60_000 }),
    }));
    expect(d.push).toBe(false);
    expect(d.reason).toMatch(/throttled/);
  });

  test('changed and past 6 hours = push', () => {
    const d = decideResync(base({
      prev: inProcess({
        sysHash: 'other', size: 1,
        syncedAt: NOW - MIN_RESYNC_INTERVAL_MS - 1000,
      }),
    }));
    expect(d.push).toBe(true);
  });

  test('force always pushes, whatever the state', () => {
    for (const prev of [null, fromDisk(), inProcess(), inProcess({ syncedAt: NOW })]) {
      expect(decideResync(base({ force: true, prev: prev })).push).toBe(true);
    }
  });

  test('sub-2% byte jitter is suppressed and re-fingerprinted, not re-pushed', () => {
    const d = decideResync(base({
      prev: inProcess({
        sysHash: 'other',
        size: Math.round(CHARS * 0.995),
        syncedAt: NOW - MIN_RESYNC_INTERVAL_MS - 1000,
      }),
    }));
    expect(d.push).toBe(false);
    expect(d.recordSkip).toBe(true);
  });

  test('jitter suppression NEVER applies when the tool list moved', () => {
    // A tool change flips its hash hard but barely moves the prompt's byte
    // count — the exact way read_email_inbox stayed dark on the assistant.
    const d = decideResync(base({
      prev: inProcess({
        toolsHash: 'tools-OLD',
        size: Math.round(CHARS * 0.999),
        syncedAt: NOW - MIN_RESYNC_INTERVAL_MS - 1000,
      }),
    }));
    expect(d.push).toBe(true);
  });

  test('the same jitter rule holds at boot — noise is noise', () => {
    const d = decideResync(base({
      prev: fromDisk({ sysHash: 'other', size: Math.round(CHARS * 0.995) }),
    }));
    expect(d.push).toBe(false);
  });

  test('the legacy {hash} shape is still understood', () => {
    const d = decideResync(base({
      prev: { hash: SYS, toolsHash: TOOLS, toolsOk: true, syncedAt: NOW - 1000, size: CHARS },
    }));
    expect(d.push).toBe(false);
  });
});

// ── Mutation guard ────────────────────────────────────────────────────────
describe('the boot property detects its own bypass', () => {
  // The pre-fix decision, reproduced exactly: everything guarded on `prev`,
  // so an absent prev falls through to a push.
  function legacyDecide(a) {
    const prev = a.prev;
    if (!a.force && prev) {
      const sysSame = (prev.sysHash || prev.hash) === a.sysHash;
      const toolsSame = prev.toolsHash === a.toolsHash && prev.toolsOk !== false;
      if (sysSame && toolsSame) return { push: false };
      if (a.now - prev.syncedAt < MIN_RESYNC_INTERVAL_MS) return { push: false };
      if (toolsSame) {
        const drift = Math.abs(a.composedChars - (prev.size || a.composedChars)) / a.composedChars;
        if (drift < MIN_DRIFT_RATIO) return { push: false };
      }
    }
    return { push: true };
  }

  test('RED — with the Map empty at boot, the legacy decision always pushes', () => {
    // Same unchanged agent, but prev is undefined because the Map is
    // process-local. Twenty deploys, twenty new agent versions, zero changes.
    let pushes = 0;
    for (let i = 0; i < 20; i++) {
      if (legacyDecide(base({ prev: undefined, now: NOW + i * 3600_000 })).push) pushes++;
    }
    expect(pushes).toBe(20);
  });

  test('GREEN — the fixed decision, same 20 deploys, pushes nothing', () => {
    let pushes = 0;
    for (let i = 0; i < 20; i++) {
      if (decideResync(base({ prev: fromDisk(), now: NOW + i * 3600_000 })).push) pushes++;
    }
    expect(pushes).toBe(0);
  });

  test('RED — dropping the fromDisk flag makes a boot deploy wait out the throttle', () => {
    // If the persisted fingerprint were loaded WITHOUT marking it as
    // disk-recovered, a genuine baseline change deployed 10 minutes after the
    // last push would be silently throttled for six hours.
    const changedAtBoot = { sysHash: 'sha-system-OLD', size: 1, syncedAt: NOW - 600_000 };
    expect(decideResync(base({ prev: fromDisk(changedAtBoot) })).push).toBe(true);
    expect(decideResync(base({ prev: inProcess(changedAtBoot) })).push).toBe(false);
  });
});
