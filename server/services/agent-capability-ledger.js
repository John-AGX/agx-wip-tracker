'use strict';

/**
 * agent-capability-ledger.js — one answer to "can this agent reach that tool?"
 *
 * WHY THIS FILE EXISTS
 *
 * Roughly ten places independently assert what the agent can do: the eleven
 * *Tools() arrays, the two name allowlists inside customToolsFor, the dispatch
 * map, AI_TOOL_CAPABILITY, SURFACE_PRIMARY_WRITES, renderAvailableToolsBlock,
 * the three AGENT_SYSTEM_BASELINE bodies, NUDGE_TEXT, and the client labels.
 * They disagree, and when they disagree the model is told to call something it
 * does not hold — which is not a degraded answer, it is a guaranteed wasted
 * turn. And a wasted turn is the most expensive thing in this system by a wide
 * margin: a retry at turn 11 re-reads ~99,200 tokens, twice.
 *
 * There was already a guard for this (test/agent-instruction-honesty.test.js)
 * and it passes while phantoms ship, for two structural reasons rather than
 * one oversight:
 *
 *   1. It runs test.each(['job', 'assistant']) — so the entire SCRIBE baseline
 *      is unexamined.
 *   2. Its extractor requires a parenthesis, so a name written in backticks
 *      with no call syntax is invisible to it.
 *
 * WHAT "REACHABLE" MEANS, AND WHY A HAND-WRITTEN LIST WOULD BE WRONG
 *
 * Registered is not the same as reachable. A dozen names reach no agent as
 * schemas yet are perfectly callable THROUGH another tool: read_entity and
 * search_entities dispatch internally to read_jobs, read_wip_summary,
 * read_subs, read_materials and more. The existing guard records exactly why a
 * naive widening was rejected — "a guard that failed on those would be noise
 * nobody keeps" — and it was right. So the alias set is DERIVED by reading the
 * dispatchReadTool('…') literals out of the source, never enumerated by hand.
 * A hand-listed alias set is a tenth source of truth, which is the problem.
 *
 * Pure, like services/usage-ledger.js and services/agent-eval-corpus.js beside
 * it: every input is passed in. That is not only for testability — requiring
 * the route from here would be a cycle, because the route is what owns the
 * tool definitions.
 */

/**
 * Names that LOOK like a tool reference in prose.
 *
 * Two forms, because the existing guard only caught one:
 *   `name`      — backticked, which is how the baselines write them
 *   name(       — call syntax, which is what the old extractor required
 *
 * Deliberately requires at least one underscore OR membership in the pool
 * (applied by the caller), so ordinary English in backticks does not register.
 * `navigate` has no underscore and is a real tool, which is exactly why pool
 * membership is the primary test and this heuristic is the fallback.
 */
const BACKTICKED = /`([a-z][a-z0-9_]{2,40})`/g;
const CALL_FORM = /\b([a-z][a-z0-9_]{2,40})\s*\(/g;

function toolShapedTokens(text) {
  const out = new Set();
  const s = String(text == null ? '' : text);
  for (const re of [BACKTICKED, CALL_FORM]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(s)) !== null) out.add(m[1]);
  }
  return out;
}

/**
 * Every tool name that has a schema anywhere, reachable or not.
 *
 * Discovered the same way test/agent-tool-description-cap.test.js discovers it
 * — the *Tools$ functions on ai-routes-internals — so the two cannot disagree
 * about what the surface is. The caller passes the internals module.
 *
 * NOTE this is a UNIQUE-NAME set over a list that contains duplicates: 14 names
 * are defined twice and 12 of those two definitions DIFFER. Which one a given
 * agent actually registers is decided by iteration order in customToolsFor, so
 * this set is the right answer for "is that a real tool name" and the WRONG
 * place to look for a tool's shape.
 */
function poolNames(internals) {
  const out = new Set();
  if (!internals) return out;
  for (const key of Object.keys(internals)) {
    if (typeof internals[key] !== 'function' || !/Tools$/.test(key)) continue;
    let list;
    try { list = internals[key](); } catch (e) { continue; }
    for (const t of (list || [])) {
      if (t && t.name) out.add(String(t.name));
    }
  }
  return out;
}

/** The names actually registered on one agent, from customToolsFor's output. */
function registeredNames(tools) {
  const out = new Set();
  for (const t of (Array.isArray(tools) ? tools : [])) {
    if (t && t.name) out.add(String(t.name));
  }
  return out;
}

/**
 * Names callable THROUGH a registered tool, read out of the source.
 *
 * Derived, never listed. If a new internal dispatch is added, this picks it up
 * on the next run; a hand-maintained copy would not, and would start reporting
 * a correct instruction as a phantom — the fastest way to get a guard deleted.
 */
function dispatchAliases(source) {
  const out = new Set();
  const re = /dispatchReadTool\(\s*['"]([a-z][a-z0-9_]{2,40})['"]/g;
  let m;
  while ((m = re.exec(String(source || ''))) !== null) out.add(m[1]);
  return out;
}

/** registered ∪ reachable-by-dispatch. */
function reachableNames(registered, aliases) {
  const out = new Set(registered || []);
  for (const a of (aliases || [])) out.add(a);
  return out;
}

/**
 * The verb prefixes real tools in this codebase use — read_, propose_, search_,
 * emit_, scribe_ and so on — derived from the pool rather than listed.
 *
 * WHY THIS EXISTS. Without it the scan is unusable. The baselines and tool
 * descriptions are full of backticked JSON FIELD names — `co_id`, `line_id`,
 * `qty_per_unit`, `to_date`, `sort_by`, `attachment_id` — and a scan that
 * treats every backticked snake_case token as a tool reference reports 45
 * names, 43 of them noise. The existing guard already recorded the consequence
 * in writing: "a guard that failed on those would be noise nobody keeps." A
 * noisy guard is deleted, and then there is no guard.
 *
 * A first segment counts as a tool verb only if at least two pool tools share
 * it, which is what separates `propose_` (many tools) from `co_` (none). So
 * `propose_outlook_reply` — a name whose only appearance in the entire tree is
 * the description instructing the model to call it — is caught, and `co_id` is
 * not. Derived, so adding a tool family needs no edit here.
 *
 * THE LIMIT, STATED. A fictional tool in a family of ONE is missed: `start_` is
 * only start_background_task, so an invented `start_whatever` would slip
 * through, the same way `start_date` is correctly ignored. That is the price of
 * being quiet enough to keep, and it is the right side of the trade — every
 * REAL tool is caught by pool membership regardless of prefix, so what escapes
 * is confined to pure fiction in a one-tool family. The threshold is the single
 * knob here, and lowering it to 1 is what a mutant below pins.
 */
function toolVerbPrefixes(pool) {
  const counts = new Map();
  for (const n of (pool || [])) {
    const seg = String(n).split('_')[0];
    if (!seg) continue;
    counts.set(seg, (counts.get(seg) || 0) + 1);
  }
  const out = new Set();
  for (const [seg, n] of counts) if (n >= 2) out.add(seg);
  return out;
}

/**
 * Scan model-visible strings for references an agent cannot act on.
 *
 * `entries` is [{ id, agentKey, text }] — the lexicon. The caller assembles it,
 * because the producers live in two route modules and this file must not
 * require either.
 *
 * A reference is reported when the token is a REAL tool name (in the pool) that
 * this agent cannot reach, or when it is tool-shaped, carries an underscore,
 * and matches no tool at all — the `propose_outlook_reply` case, where the name
 * exists in exactly one place in the tree: the description that tells the model
 * to call it.
 */
function unreachableReferences(entries, opts) {
  const o = opts || {};
  const pool = o.pool || new Set();
  const reachableFor = o.reachableFor || (() => new Set());
  const ignore = o.ignore || new Set();
  const verbs = o.verbs || toolVerbPrefixes(pool);
  const found = [];

  for (const e of (Array.isArray(entries) ? entries : [])) {
    if (!e || !e.text) continue;
    const reachable = reachableFor(e.agentKey) || new Set();
    for (const token of toolShapedTokens(e.text)) {
      if (ignore.has(token)) continue;
      if (reachable.has(token)) continue;
      const inPool = pool.has(token);
      // Not a real tool name, and not even shaped like one by this codebase's
      // own naming — a backticked JSON field, or a bare English verb caught by
      // the call-form pattern (`read(`, `list(`, `set(`). Both halves are
      // needed: the prefix test alone keeps `read` and `list`, and the
      // underscore test alone keeps `co_id` and `qty_per_unit`. Every real tool
      // whose name is a single word (navigate, recall) is in the pool, so it is
      // admitted by membership and never reaches this line. See
      // toolVerbPrefixes for why this filter decides whether the guard survives
      // contact with the baselines at all.
      if (!inPool && !(token.indexOf('_') !== -1 && verbs.has(token.split('_')[0]))) continue;
      found.push({
        id: e.id,
        agentKey: e.agentKey,
        name: token,
        kind: inPool ? 'registered_to_another_agent' : 'no_such_tool',
      });
    }
  }
  // Stable, deduped: one row per (entry, name).
  const seen = new Set();
  return found.filter(r => {
    const k = r.id + '|' + r.name;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).sort((a, b) => (a.id + a.name).localeCompare(b.id + b.name));
}

module.exports = {
  toolShapedTokens,
  toolVerbPrefixes,
  poolNames,
  registeredNames,
  dispatchAliases,
  reachableNames,
  unreachableReferences,
};
