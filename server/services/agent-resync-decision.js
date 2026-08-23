'use strict';

/**
 * agent-resync-decision.js — should the sweep push a new agent version?
 *
 * WHY THIS IS ITS OWN FILE
 *
 * The decision used to be five nested ifs inside resyncDriftedAgents, and the
 * whole of it lived inside `if (!force && prev)`. When `prev` was undefined
 * every branch was skipped and control fell straight through to
 * beta.agents.update. `prev` came from a process-local Map that is empty at
 * boot. So: every process start pushed a new agent version unconditionally,
 * whether or not a single byte had changed.
 *
 * On the Anthropic Agents API each update mints a new immutable version —
 * it does so even when the fields you send already equal the stored values.
 * Every Railway deploy restarts the process. The live 86 agent was on version
 * 487 in 97 days: ~5 a day, exactly the deploy cadence of a repo with three
 * concurrent sessions pushing to main. The throttle that was supposed to hold
 * this to 0-4 pushes a day was structurally incapable of firing on the one
 * event that happens most often.
 *
 * Pulling the decision out here makes it a function of its inputs, so the
 * boot case can be tested without a process restart and a stale-state
 * regression cannot hide inside control flow.
 *
 * THE `fromDisk` DISTINCTION
 *
 * With the fingerprint persisted to managed_agent_registry, boot now HAS a
 * prior state to compare against. But a boot is not just another 15-minute
 * tick: it is a discrete operator event ("I deployed new code, land it"). So
 * a disk-loaded prev keeps the old boot semantics for the case that matters —
 * content actually changed → push NOW, no 6-hour throttle — and drops them
 * only for the case that was pure waste: nothing changed → do not push.
 *
 * The sub-2% jitter filter still applies at boot, because that filter is
 * about content noise (SharePoint whitespace), not about timing.
 */

const MIN_RESYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MIN_DRIFT_RATIO = 0.02;

/**
 * @param {object} a
 * @param {boolean} a.force          admin clicked Sync now
 * @param {object|null} a.prev       { sysHash, toolsHash, toolsOk, syncedAt, size, fromDisk }
 * @param {string} a.sysHash         hash of composed system + model, now
 * @param {string} a.toolsHash       hash of the tool list, now
 * @param {number} a.composedChars   length of the composed system prompt, now
 * @param {number} [a.now]
 * @param {number} [a.minIntervalMs]
 * @param {number} [a.minDriftRatio]
 * @returns {{push: boolean, reason: string, recordSkip: boolean}}
 *   recordSkip: true when we skipped but should still refresh the stored
 *   fingerprint (the jitter case — otherwise every tick re-measures the same
 *   sub-threshold drift forever).
 */
function decideResync(a) {
  const prev = a && a.prev;
  const now = Number.isFinite(a.now) ? a.now : Date.now();
  const minInterval = Number.isFinite(a.minIntervalMs) ? a.minIntervalMs : MIN_RESYNC_INTERVAL_MS;
  const minDrift = Number.isFinite(a.minDriftRatio) ? a.minDriftRatio : MIN_DRIFT_RATIO;

  if (a.force) return { push: true, reason: 'forced', recordSkip: false };
  if (!prev) {
    return {
      push: true,
      reason: 'no fingerprint on record for this agent — first push',
      recordSkip: false
    };
  }

  // Tolerate the older {hash} shape the in-process Map used to write.
  const prevSys = prev.sysHash || prev.hash;
  const sysSame = prevSys === a.sysHash;
  const toolsSame = prev.toolsHash === a.toolsHash && prev.toolsOk !== false;

  // THE FIX. Nothing changed — including at boot, which is precisely where
  // this used to be unreachable. No push, no new version, no cache
  // invalidation for every session on the agent.
  if (sysSame && toolsSame) {
    return { push: false, reason: 'identical to the last push', recordSkip: false };
  }

  // Something DID change. A disk-loaded fingerprint means this is the first
  // tick of a new process — an operator deployed something. Land it now
  // rather than making them wait out a throttle they cannot see.
  if (prev.fromDisk) {
    // The jitter filter still applies: sub-threshold byte noise is noise
    // whether or not the process just restarted.
    const jitter = _jitterSkip(a, prev, toolsSame, minDrift);
    if (jitter) return jitter;
    return { push: true, reason: 'boot: content changed since the last recorded push', recordSkip: false };
  }

  if (now - prev.syncedAt < minInterval) {
    return {
      push: false,
      reason: 'throttled — last push ' + Math.round((now - prev.syncedAt) / 60000) + 'min ago',
      recordSkip: false
    };
  }

  const jitter = _jitterSkip(a, prev, toolsSame, minDrift);
  if (jitter) return jitter;

  return { push: true, reason: 'content drifted', recordSkip: false };
}

// Suppress sub-threshold byte jitter ONLY when the tool list is unchanged —
// a tool change always pushes (its hash flips hard; the prompt's byte size
// does not move with it).
function _jitterSkip(a, prev, toolsSame, minDrift) {
  if (!toolsSame) return null;
  const size = Number.isFinite(prev.size) ? prev.size : a.composedChars;
  const delta = Math.abs(a.composedChars - size);
  const drift = a.composedChars ? delta / a.composedChars : 1;
  if (drift >= minDrift) return null;
  return {
    push: false,
    reason: 'sub-' + (minDrift * 100) + '% byte jitter (' + delta + ' chars)',
    recordSkip: true
  };
}

module.exports = { decideResync, MIN_RESYNC_INTERVAL_MS, MIN_DRIFT_RATIO };
