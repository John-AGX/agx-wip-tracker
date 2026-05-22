// p86-skill-bodies.js — registry of native Anthropic Skills shipped
// with a fresh Project 86 organization.
//
// Architecture decision (2026-05-21): a fresh org ships with ONLY
// identity built in. No domain playbook skills. No "Estimator
// Structure Playbook" / "PM WIP Playbook" / etc. The Principal (86)
// is one agent with one write primitive (emit_payload_file); the
// format spec lives in the Principal's baseline, not in a separate
// skill. Staff agents are background watchers only — they get scope
// and instructions at watch-runner fire time, not via durable skills.
//
// Custom orgs can add domain overlays via the section-pack mechanism
// in app_settings.agent_skills.skills[] (admin-editable). But OUT OF
// THE BOX, no playbooks ship.
//
// Each entry in SKILL_DEFINITIONS would carry:
//   - agent_key:    which managed agent the skill links to
//   - display_title: shown in the Anthropic Skills dashboard
//   - slug:         used as the markdown `name:` in frontmatter
//   - description:  triggers when the model decides to invoke the skill
//   - body:         the SKILL.md body content
//
// SKILL_DEFINITIONS is exported as a list so installers can iterate
// idempotently. Empty list = no skills installed by default.

const SKILL_DEFINITIONS = [];

module.exports = {
  SKILL_DEFINITIONS,
};
