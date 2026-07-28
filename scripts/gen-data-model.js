#!/usr/bin/env node
// Generate docs/DATA_MODEL.md from the authoritative schema in server/db.js.
//
// server/db.js holds every `CREATE TABLE IF NOT EXISTS` definition and is the
// single source of truth for the data model; this script reads it and emits a
// human-readable entity reference (tables, columns, foreign keys) grouped by
// subsystem. Structure only — it never touches the database or emits data.
//
// Run after any schema change:  node scripts/gen-data-model.js

'use strict';

const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, '..', 'server', 'db.js');
const OUT = path.join(__dirname, '..', 'docs', 'DATA_MODEL.md');

// Subsystem grouping. Tables not listed fall into "Other / supporting" — add
// them here as new subsystems land so the doc keeps reading by domain.
const GROUPS = [
  ['Identity, tenancy & access', [
    'users', 'organizations', 'roles', 'org_invitations', 'job_access',
    'subs', 'sub_invites', 'sub_certificates', 'admin_audit_log',
    'usage_counters', 'plans', 'plan_versions', 'org_skill_packs',
  ]],
  ['Sales — leads, estimates & clients', [
    'leads', 'estimates', 'clients', 'lead_graphs', 'deal_memory',
    'payload_templates', 'list_views',
  ]],
  ['Jobs, scopes & money', [
    'jobs', 'job_change_orders', 'job_purchase_orders', 'job_vendor_bills',
    'job_subs', 'job_workflow_items', 'job_reports', 'invoices', 'payments',
    'pay_applications', 'qb_cost_lines', 'cost_categories', 'receipts',
    'receipt_ocr_feedback', 'node_graphs', 'compliance_items',
  ]],
  ['Cost intelligence — assemblies & materials', [
    'assemblies', 'assembly_items', 'assembly_tuning_log', 'assembly_research',
    'assembly_trades', 'assembly_systems', 'assembly_variants',
    'materials', 'material_purchases', 'user_material_favorites',
  ]],
  ['AI crew — sessions, memory & training', [
    'ai_messages', 'ai_sessions', 'ai_memories', 'ai_subtasks', 'ai_replays',
    'ai_watches', 'ai_watch_runs', 'ai_evals', 'ai_eval_runs',
    'ai_training_examples', 'agent_jobs', 'agent_reference_links',
    'agent_skills_versions', 'managed_agent_registry', 'managed_agent_skills',
    'managed_environment_registry', 'staff_agents', 'org_memory',
    'org_mcp_servers', 'payloads', 'context_load_events', 'batch_jobs',
  ]],
  ['Files, projects & documents', [
    'attachments', 'attachment_folder_grants', 'file_folders',
    'org_folder_templates', 'projects', 'project_activity', 'project_pairs',
    'org_tags', 'field_tools', 'field_tool_runs', 'field_tool_drafts',
  ]],
  ['Communications & scheduling', [
    'messages', 'message_reads', 'inbound_emails', 'email_thread_state',
    'email_log', 'email_log_events', 'email_campaigns',
    'email_campaign_recipients', 'email_template_overrides', 'sms_log',
    'push_subscriptions', 'calendar_events', 'schedule_entries', 'reminders',
    'tasks', 'user_notes', 'oauth_tokens', 'app_settings',
  ]],
];

// Strip SQL line comments AND JS line comments so prose inside a CREATE TABLE
// block (which often contains commas) can't be mistaken for column names.
// Note: split on /\r?\n/ — the repo has CRLF line endings, and JS regex `.`
// does not match \r, so a trailing \r would stop /--.*$/ from ever matching
// and comment prose (which contains commas) would leak in as column names.
function stripComments(src) {
  return src
    .split(/\r?\n/)
    .map((line) => line.replace(/--.*$/, '').replace(/\/\/.*$/, ''))
    .join('\n');
}

function parseTables(src) {
  const re = /CREATE TABLE IF NOT EXISTS\s+([a-z_0-9]+)\s*\(/gi;
  const tables = [];
  let m;
  while ((m = re.exec(src))) {
    const name = m[1];
    // Walk to the matching close paren so nested type/constraint parens
    // (NUMERIC(12,2), CHECK (...)) don't terminate the block early.
    let depth = 1;
    let i = re.lastIndex;
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (c === '(') depth++;
      else if (c === ')') depth--;
      i++;
    }
    const body = src.slice(re.lastIndex, i - 1);

    // Split on top-level commas only.
    const parts = [];
    let d = 0;
    let cur = '';
    for (const ch of body) {
      if (ch === '(') d++;
      if (ch === ')') d--;
      if (ch === ',' && d === 0) { parts.push(cur); cur = ''; } else cur += ch;
    }
    parts.push(cur);

    const cols = parts
      .map((p) => p.trim().split(/\s+/)[0])
      .filter((c) => c && /^[a-z_][a-z_0-9]*$/.test(c))
      .filter((c) => !/^(primary|foreign|unique|check|constraint|references)$/i.test(c));

    const fks = [...new Set(
      [...body.matchAll(/REFERENCES\s+([a-z_0-9]+)/gi)].map((x) => x[1])
    )];

    tables.push({ name, cols: [...new Set(cols)], fks });
  }

  // Columns added by migration, not in the original CREATE TABLE. The schema
  // evolves via `ALTER TABLE x ADD COLUMN IF NOT EXISTS y ...` (~190 of them),
  // so a CREATE-only parse silently UNDER-REPORTS the real table shape — which
  // is worse than no doc, because a reader concludes a column is absent when it
  // is merely added later (e.g. materials.organization_id, whose absence would
  // wrongly read as a tenancy gap).
  const byName = Object.fromEntries(tables.map((t) => [t.name, t]));
  const alterRe = /ALTER TABLE\s+(?:IF EXISTS\s+)?([a-z_0-9]+)\s+ADD COLUMN IF NOT EXISTS\s+([a-z_0-9]+)([^;]*)/gi;
  let a;
  while ((a = alterRe.exec(src))) {
    const t = byName[a[1]];
    if (!t) continue;
    if (!t.cols.includes(a[2])) t.cols.push(a[2]);
    const ref = /REFERENCES\s+([a-z_0-9]+)/i.exec(a[3] || '');
    if (ref && !t.fks.includes(ref[1])) t.fks.push(ref[1]);
  }
  return tables;
}

function render(tables, stamp) {
  const byName = Object.fromEntries(tables.map((t) => [t.name, t]));
  const seen = new Set();
  const out = [];

  out.push('# Project 86 — Data Model Reference');
  out.push('');
  out.push(`**Generated:** ${stamp} · **Source of truth:** \`server/db.js\` · **Tables:** ${tables.length}`);
  out.push('');
  out.push('> Generated by `scripts/gen-data-model.js` from the `CREATE TABLE` definitions in `server/db.js`, which is the single authoritative source for the data model. Structure only — this document contains no data. Regenerate after any schema change.');
  out.push('');

  const sections = [];
  for (const [group, names] of GROUPS) {
    const present = names.filter((n) => byName[n]);
    if (present.length) sections.push([group, present]);
  }
  const rest = tables.filter((t) => !sections.some(([, ns]) => ns.includes(t.name)));
  if (rest.length) sections.push(['Other / supporting', rest.map((t) => t.name)]);

  out.push('## Contents');
  out.push('');
  sections.forEach(([g, ns]) => out.push(`- ${g} (${ns.length})`));
  out.push('');

  for (const [group, names] of sections) {
    out.push(`## ${group}`);
    out.push('');
    out.push('| Table | Columns | References |');
    out.push('|---|---|---|');
    for (const n of names) {
      seen.add(n);
      const t = byName[n];
      const fks = t.fks.length ? t.fks.map((f) => `\`${f}\``).join(', ') : '—';
      out.push(`| \`${t.name}\` | ${t.cols.join(', ')} | ${fks} |`);
    }
    out.push('');
  }

  out.push('---');
  out.push('');
  out.push('## Notes');
  out.push('');
  out.push('- **One model, one file.** Every table is defined in `server/db.js` and created idempotently at boot, so a fresh environment reaches the current schema simply by starting the app.');
  out.push('- **Tenancy.** Org-scoped tables carry `organization_id`; access is enforced in the application layer (capability gating + per-organization scoping).');
  out.push('- **Regenerate:** `node scripts/gen-data-model.js` after schema changes so this file tracks `server/db.js`.');
  out.push('');
  return out.join('\n');
}

const src = stripComments(fs.readFileSync(DB_FILE, 'utf8'));
const tables = parseTables(src);
const stamp = process.argv[2] || new Date().toISOString().slice(0, 10);
fs.writeFileSync(OUT, render(tables, stamp));
console.log(`Wrote ${path.relative(process.cwd(), OUT)} — ${tables.length} tables`);
