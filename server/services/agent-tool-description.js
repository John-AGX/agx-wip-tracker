'use strict';

/**
 * agent-tool-description.js — the 1024-char cap on a managed-agent tool
 * description, and the only place allowed to apply it.
 *
 * Anthropic's managed-agents schema rejects a custom tool whose description
 * exceeds 1024 characters, so the registrar truncates rather than failing the
 * whole bootstrap. That trade is fine. Doing it SILENTLY was not.
 *
 * emit_payload_file — the Scribe's only tool, the thing that performs every
 * money write in this system — carried a 4694-char description. 3673 chars
 * were cut, every deploy, with no log line. And a tail-cut deletes whatever
 * was documented LAST: the retired node-graph ops survived because they were
 * written years ago and sit early in the string, while task, todo, reminder,
 * calendar_event and the bulk/move/condition target forms were appended later
 * and fell off the cliff. The Assistant's own baseline was meanwhile telling
 * it to order `scribe_write entity_type:'calendar_event'` — a type the Scribe
 * could not see. That is the shape of the failure this file exists to make
 * impossible to repeat quietly.
 *
 * The fix for an over-cap description is NEVER to raise the cap: the
 * description ships on every turn of every agent that holds the tool. Move
 * detail into the agent's system baseline, which is not capped.
 */

const AGENT_TOOL_DESC_CAP = 1024;

/**
 * Returns { description, truncated, overBy, warning }.
 * `warning` is a ready-to-log string when truncation happened, else null —
 * the caller decides where it goes (console.warn in the registrar).
 */
function capToolDescription(name, description) {
  const desc = (description == null ? '' : String(description));
  if (desc.length <= AGENT_TOOL_DESC_CAP) {
    return { description: desc, truncated: false, overBy: 0, warning: null };
  }
  const overBy = desc.length - AGENT_TOOL_DESC_CAP;
  // Show the text straddling the cut so the warning says WHAT was lost, not
  // just that something was.
  const atTheCut = desc
    .slice(AGENT_TOOL_DESC_CAP - 40, AGENT_TOOL_DESC_CAP + 60)
    .replace(/\s+/g, ' ');
  return {
    description: desc.slice(0, AGENT_TOOL_DESC_CAP - 3) + '...',
    truncated: true,
    overBy,
    warning:
      '[agents] TOOL DESCRIPTION TRUNCATED: ' + (name || '(unnamed tool)') +
      ' is ' + desc.length + ' chars, ' + overBy + ' over the ' + AGENT_TOOL_DESC_CAP +
      '-char managed-agents cap. The TAIL is cut — whatever was documented LAST is now ' +
      'INVISIBLE to the agent. Shorten it and move detail into the agent\'s system ' +
      'baseline (not capped); do NOT raise the cap. Text at the cut: "…' + atTheCut + '…"',
  };
}

module.exports = { AGENT_TOOL_DESC_CAP, capToolDescription };
