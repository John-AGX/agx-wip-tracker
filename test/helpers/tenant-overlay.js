// THE SHARED TWO-ORG OVERLAY — ONE FIXTURE, EVERY REGISTER.
//
// ── WHY IT MOVED OUT OF THE TEST FILE ────────────────────────────────────
// This overlay used to live inside test/tenant-conformance.test.js, which was
// fine while ONE register existed. Register 2 (the HTTP route census) needs the
// same rows, and a second hand-written copy is precisely the mistake the
// two-org header spends a paragraph on: two independently written seeds make a
// differential compare the seeds rather than the code, and two independently
// maintained fixtures drift until one of them is quietly wrong about which row
// is the victim's.
//
// So there is one. Both registers require it, neither can edit it for itself,
// and a row added for one is a row the other gets.
//
// Everything below is unchanged from where it was written, including the
// reasons. See test/helpers/two-org.js for what the generic seeder does
// underneath it and why every id here is DERIVED rather than typed.
'use strict';

const TWO = require('./two-org');
const { ORG_A, ORG_B, MARK } = TWO;

// A FIXED recent instant, computed once and shared by BOTH worlds. The rolling
// windows in these tools are `NOW() - INTERVAL '7 days'`, so a row has to be
// recent to be in scope at all; taking `new Date()` separately per engine would
// put a different timestamp in each world and make Arm 3 report a difference
// that is an artefact of the fixture rather than of the code.
const RECENT = new Date(Date.now() - 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');

// A poisoned money figure for org B. In the band by construction.
const P = 900007000;

function estBlob(tag, total, unitCost) {
  return JSON.stringify({
    title: tag + ' Clubhouse Re-roof', clientId: 'clients-' + tag,
    totalProposal: total, status: 'sent',
    lines: [{
      id: 'l1', description: tag + ' seamless gutters 6in', qty: 40, unit: 'lf',
      unitCost: unitCost, markup: 42, section: 'Gutters',
    }],
  });
}

function jobBlob(tag, money) {
  return JSON.stringify({
    jobNumber: 'J-' + tag, title: tag + ' Job', clientId: 'clients-' + tag,
    buildings: [{ id: 'b1', name: tag + ' Building One', pctComplete: 50 }],
    phases: [{
      id: 'p1', buildingId: 'b1', name: tag + ' Phase',
      phaseBudget: money, asSoldRevenue: money, pctComplete: 50,
    }],
  });
}

// ── THE OVERLAY ───────────────────────────────────────────────────────────
// The generic seeder in test/helpers/two-org.js already puts three rows in
// every one of the 108 tables, so no door can pass by reading an empty table.
// This overlay only makes the rows the driven doors KEY ON realistic: a jobs
// blob with buildings and phases, an attachment pointing at an estimate that
// exists, JSON where a handler calls JSON.parse.
//
// It sets VALUES ONLY. Every column named here is checked against the derived
// schema before it is written (applyOverlay in the helper), so this overlay
// cannot invent a column — which is the exact failure that let a hand-written
// `attachments.created_at` keep two shipped agent tools green while both raised
// 42703 in production.
//
// EVERY ID IS DERIVED, never typed. TWO.idFor(table, tenant) returns the id the
// generic seeder used, in the type server/db.js declares for that table's key.
// The first draft of this overlay typed them, and got two of them exactly
// backwards: `ai_sessions.id` is BIGSERIAL and `ai_messages.id` is TEXT, not the
// other way round. sqlite answered with the bare words "datatype mismatch" and
// no table name. Deriving the id makes that class of mistake unwritable, and
// makes the overlay and the generic seed incapable of disagreeing about which
// row they mean.
const ID = (t, tag) => TWO.idFor(t, tag);

const OVERLAY = {
  organizations: [
    { id: ORG_A, name: 'Affiliate Alpha', slug: 'alpha' },
    { id: ORG_B, name: MARK + ' Affiliate', slug: 'zzvictimbravo' },
  ],
  roles: [{
    name: 'admin', label: 'Admin',
    capabilities: JSON.stringify(['ESTIMATES_VIEW', 'ESTIMATES_EDIT', 'FINANCIALS_VIEW',
      'INSIGHTS_VIEW', 'JOBS_VIEW', 'LEADS_VIEW', 'CLIENTS_VIEW', 'SUBS_VIEW', 'SCHEDULE_VIEW',
      'TASKS_VIEW', 'FILES_VIEW', 'REPORTS_VIEW', 'JOBS_EDIT', 'LEADS_EDIT', 'CLIENTS_EDIT',
      'ROLES_MANAGE']),
  }],
  users: [
    { id: ID('users', 'A'), organization_id: ORG_A, email: 'a@a.a', name: 'A Admin', role: 'admin', active: 1 },
    { id: ID('users', 'B'), organization_id: ORG_B, email: MARK + '@b.b', name: MARK + ' Admin', role: 'admin', active: 1 },
    { id: ID('users', 'N'), organization_id: null, email: 'n@n.n', name: 'Orphan', role: 'admin', active: 1 },
  ],
  estimates: [
    { id: ID('estimates', 'A'), organization_id: ORG_A, owner_id: ID('users', 'A'), data: estBlob('A-0', 250, 11), is_locked: 0, updated_at: RECENT },
    { id: ID('estimates', 'B'), organization_id: ORG_B, owner_id: ID('users', 'B'), data: estBlob(MARK, P, P), is_locked: 0, updated_at: RECENT },
    { id: ID('estimates', 'N'), organization_id: null, owner_id: null, data: estBlob('N-2', 100, 9), is_locked: 0, updated_at: RECENT },
  ],
  jobs: [
    { id: ID('jobs', 'A'), organization_id: ORG_A, owner_id: ID('users', 'A'), data: jobBlob('A-0', 1000) },
    { id: ID('jobs', 'B'), organization_id: ORG_B, owner_id: ID('users', 'B'), data: jobBlob(MARK, P) },
    { id: ID('jobs', 'N'), organization_id: null, owner_id: null, data: jobBlob('N-2', 10) },
  ],
  clients: [
    { id: ID('clients', 'A'), organization_id: ORG_A, name: 'Alpha HOA', agent_notes: '[]', client_type: 'hoa', city: 'Orlando', activation_status: 'active' },
    { id: ID('clients', 'B'), organization_id: ORG_B, name: MARK + ' Property Group', agent_notes: JSON.stringify([{ body: MARK + ' confidential note' }]), client_type: 'hoa', city: 'Orlando', activation_status: 'active' },
    { id: ID('clients', 'N'), organization_id: null, name: 'Legacy Client', agent_notes: '[]', client_type: 'hoa', city: 'Orlando', activation_status: 'active' },
  ],
  attachments: [
    { id: ID('attachments', 'A'), organization_id: ORG_A, entity_type: 'estimate', entity_id: ID('estimates', 'A'), filename: 'alpha.pdf', mime_type: 'application/pdf', extracted_text: 'ALPHA scope text', uploaded_by: ID('users', 'A'), web_key: 'k/a' },
    { id: ID('attachments', 'B'), organization_id: ORG_B, entity_type: 'estimate', entity_id: ID('estimates', 'B'), filename: MARK + '.pdf', mime_type: 'application/pdf', extracted_text: MARK + ' contract text', uploaded_by: ID('users', 'B'), web_key: 'k/b' },
    { id: ID('attachments', 'N'), organization_id: null, entity_type: 'estimate', entity_id: ID('estimates', 'N'), filename: 'legacy.pdf', mime_type: 'application/pdf', extracted_text: 'LEGACY text', uploaded_by: null, web_key: 'k/n' },
  ],
  qb_cost_lines: [
    { id: ID('qb_cost_lines', 'A'), organization_id: ORG_A, job_id: ID('jobs', 'A'), amount: 150, vendor: 'Alpha Supply' },
    { id: ID('qb_cost_lines', 'B'), organization_id: ORG_B, job_id: ID('jobs', 'B'), amount: P, vendor: MARK + ' Supply' },
    { id: ID('qb_cost_lines', 'N'), organization_id: null, job_id: ID('jobs', 'N'), amount: 7, vendor: 'Legacy Supply' },
  ],
  messages: [
    { id: ID('messages', 'A'), organization_id: ORG_A, thread_key: 'attachment:' + ID('attachments', 'A'), user_id: ID('users', 'A'), body: 'alpha comment', created_at: RECENT },
    { id: ID('messages', 'B'), organization_id: ORG_B, thread_key: 'attachment:' + ID('attachments', 'B'), user_id: ID('users', 'B'), body: MARK + ' comment', created_at: RECENT },
  ],
  ai_messages: [
    { id: ID('ai_messages', 'A'), organization_id: ORG_A, entity_type: 'estimate', estimate_id: ID('estimates', 'A'), user_id: ID('users', 'A'), session_id: ID('ai_sessions', 'A'), role: 'assistant', content: 'alpha turn', model: 'claude-sonnet-5', input_tokens: 10, output_tokens: 20, tool_use_count: 1, tool_uses: '[{"name":"read_jobs"}]', created_at: RECENT },
    { id: ID('ai_messages', 'B'), organization_id: ORG_B, entity_type: 'estimate', estimate_id: ID('estimates', 'B'), user_id: ID('users', 'B'), session_id: ID('ai_sessions', 'B'), role: 'assistant', content: MARK + ' turn', model: 'claude-opus-5', input_tokens: P, output_tokens: P, tool_use_count: 1, tool_uses: '[{"name":"zzvictim_tool"}]', created_at: RECENT },
    { id: ID('ai_messages', 'N'), organization_id: null, entity_type: 'estimate', estimate_id: ID('estimates', 'N'), user_id: ID('users', 'N'), session_id: ID('ai_sessions', 'N'), role: 'assistant', content: 'legacy turn', model: 'claude-sonnet-5', input_tokens: 5, output_tokens: 6, tool_use_count: 0, tool_uses: '[]', created_at: RECENT },
    // ── THE ROW WITHOUT WHICH THE L2 DEFECT IS UNREACHABLE ────────────────
    // An ORG-A thread whose entity id NAMES AN ORG-B ESTIMATE. `ai_messages`
    // .estimate_id is not a foreign key to anything, so this shape is legal and
    // occurs in practice.
    //
    // It is here because of a specific, documented near-miss: when the L2 fix
    // was mutation-tested in `3e2c70a2`, reverting the two batched title
    // lookups killed NO test — the conversation list's own row-stamp predicate
    // already kept foreign ids out of the batch, so the title lookup was never
    // ASKED for one, and a real repair was indistinguishable from its absence.
    // Without this row the harness is green on the pre-repair code for L2, and
    // "green" would mean "not exercised".
    { id: 'am-a-points-at-b', organization_id: ORG_A, entity_type: 'estimate', estimate_id: ID('estimates', 'B'), user_id: ID('users', 'A'), session_id: ID('ai_sessions', 'A'), role: 'assistant', content: 'alpha thread about a foreign id', model: 'claude-sonnet-5', input_tokens: 3, output_tokens: 4, tool_use_count: 0, tool_uses: '[]', created_at: RECENT },
  ],
  // `ai_sessions` names its user-typed string `label`, not `title` — the first
  // draft of this overlay typed `title` and the fixture REFUSED TO LOAD. That
  // refusal is the point: an overlay that could invent a column would be a
  // second schema, and a second schema drifts toward whatever the code under
  // test happens to ask for. It is also the table with no tenant column at all
  // (see the G3 waiver in docs/TENANCY-GRADUATION.md).
  ai_sessions: [
    { id: ID('ai_sessions', 'A'), user_id: ID('users', 'A'), label: 'alpha session', summary: 'alpha summary', entity_type: 'general' },
    { id: ID('ai_sessions', 'B'), user_id: ID('users', 'B'), label: MARK + ' session', summary: MARK + ' summary', entity_type: 'general' },
  ],
};

module.exports = { overlay: OVERLAY, ID, RECENT, P, estBlob, jobBlob };
