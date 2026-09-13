// test/payload-describe.test.js — the one-line approval description and the
// click-only verdict (server/services/payload-describe.js).
//
// What this file has to prove, and the failure each block prevents:
//
//   INCIDENT 2026-08-09 — a payload titled "Convert estimate to job" whose only
//   op was estimate field_updates {status:'sold'} auto-applied. So: the line is
//   built from ops, never from a title/summary/rationale, and that status
//   change is click-only in every shape the dispatcher executes — plain, inside
//   bulk.items[].ops, as a bulk item that IS its own ops, on either side of a
//   move, and under a capitalised entity_type.
//
//   JOHN'S CLICK-ONLY RULES (2026-09-12) — deletes of every shape, money edits,
//   completion % under every spelling, system targets, outbound sends,
//   status on money-bearing records, anything unrecognised. And the other
//   direction: personal to-dos, reminders and calendar events stay LOW, or the
//   spoken "yes" this exists for never fires.
//
//   THE LINE — no raw id ever reaches it; long values are cut; the click-only
//   change leads and is never what "+N more" hides.
//
// FIXTURES ARE DISPATCHER SHAPES. Every fixture marked `door: true` is passed
// through payload-dispatcher's own validateTarget, so a shape this file invents
// fails here instead of passing vacuously. The few with `door: false` are
// deliberately NOT doors (no bill entity exists; 'Estimate' is refused) and
// the test asserts the dispatcher refuses them — they are here because a
// classifier must still say "high" for a door that appears before it learns it.
//
// Every assertion below was mutation-tested against the real module (see the
// mutation list at the end of this file's describe blocks).

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const MODULE_PATH = path.join(ROOT, 'server', 'services', 'payload-describe.js');
const { describePayload, classifyRisk, ENTITY_TOP_KEYS } = require(MODULE_PATH);
// The spec's number, written here rather than imported: a test that reads the
// cap from the module passes whatever the cap becomes.
const VALUE_CAP = 40;
const dispatcher = require('../server/services/payload-dispatcher');

// ── ids and names ───────────────────────────────────────────────────────────
const EST = 'est_1757000000_fsq01';
const JOB = 'job_1757000000_hbp02';
const LEAD = 'lead_1757000000_smr03';
const CLIENT = 'client_1757000000_acm04';
const CO = 'co_1757000000_x7k2';
const PO = 'po_1757000000_p9q1';
const INV = 'inv_1757000000_q1w2';
const PHASE = 'ph_framing_884133';
const LINE = 'line_1757000000_ln01';
const LINE2 = 'line_1757000000_ln02';
const SECTION = 'section_1757000000_se01';
const GROUP = 'alt_1757000000_gr01';
const ENTRY = 'sched_1757000000_en01';
const ATT = 'att_1757000000_ph01';
const ATT2 = 'att_1757000000_ph02';
const TICKET = 'st_1757000000_tk01';
const REPORT = 'rpt_1757000000_rp01';
const PROJECT = 'proj_1757000000_pj01';
const BILL = 'bill_1757000000_bl01';
const PAYAPP = 'payapp_1757000000_pa01';
const PACK = 'pack_1757000000_sk01';
const NOTE = 'note_1757000000_nt01';

const ALL_IDS = [EST, JOB, LEAD, CLIENT, CO, PO, INV, PHASE, LINE, LINE2, SECTION, GROUP, ENTRY, ATT,
  ATT2, TICKET, REPORT, PROJECT, BILL, PAYAPP, PACK, NOTE];

const NAMES = {
  estimate: { [EST]: 'Fountain Square' },
  job: { [JOB]: 'Harbor Point' },
  lead: { [LEAD]: 'Smith Residence' },
  client: { [CLIENT]: 'Acme HOA' },
  change_order: { [CO]: 'CO-3' },
  project: { [PROJECT]: 'Bayview Towers' },
};
const nameFor = (type, id) => (NAMES[type] && NAMES[type][id]) || null;

// A dry-run changeset in the shape dispatchConcrete stores: full to_jsonb rows,
// estimate / job money inside `data`, client and lead columns at top level, and
// attachment rows from changeset_rows.
const CHANGESET = [
  { entity_type: 'estimate', id: EST, before: { id: EST, is_locked: false, data: {
    name: 'Fountain Square', status: 'draft', tax_rate: 7,
    lines: [
      { id: LINE, description: 'Stucco patch', qty: 1, unitCost: 1200, markup: '' },
      { id: LINE2, description: 'Paint, two coats', qty: 40, unitCost: 3.5, markup: '' },
    ] } }, after: {} },
  { entity_type: 'job', id: JOB, before: { id: JOB, client_id: 'client_column_value', data: {
    client_id: 'client_blob_value',
    title: 'Harbor Point', status: 'active', contractAmount: 250000,
    phases: [{ id: PHASE, name: 'Framing', pctComplete: 40, materials: 1000 }] } }, after: {} },
  { entity_type: 'client', id: CLIENT, before: { id: CLIENT, name: 'Acme HOA', phone: '(813) 555-0199',
    city: 'Tampa', notes: '' }, after: {} },
  { entity_type: 'lead', id: LEAD, before: { id: LEAD, title: 'Smith Residence', street_address: '12 Old Rd',
    state: 'FL', gate_code: '1111', status: 'new' }, after: {} },
  { entity_type: 'attachment', id: ATT, before: { id: ATT, caption: 'north wall', tags: [] }, after: {} },
];

const describeIt = (targets, opts) => describePayload(targets, CHANGESET, Object.assign({ nameFor }, opts || {}));

// ── the dispatcher door, used to prove a fixture is a real shape ────────────
function dispatcherAccepts(target) {
  try { dispatcher.validateTarget(JSON.parse(JSON.stringify(target)), 0); return true; }
  catch (_) { return false; }
}

// isHighRiskPayload lives in routes/payload-routes.js, which requires ../auth
// and cannot load without a JWT_SECRET. Its body is self-contained, so it is
// lifted out of the file and RUN — not pattern-matched — to check that nothing
// the current gate cards is called low here. A failed lift throws; it never
// silently yields a function that returns false.
// isHighRiskPayload now ORs this module on top of that scan, so the scan
// itself — legacyHighRiskScan — is what is lifted: the property is still
// "nothing the string scan cards is called low by the walk".
function liftIsHighRiskPayload() {
  const src = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'payload-routes.js'), 'utf8');
  const start = src.indexOf('function legacyHighRiskScan(');
  if (start < 0) throw new Error('legacyHighRiskScan not found in payload-routes.js');
  const rest = src.slice(start);
  const end = /\r?\n\}\r?\n/.exec(rest);
  if (!end) throw new Error('end of legacyHighRiskScan not found');
  // eslint-disable-next-line no-new-func
  return new Function(rest.slice(0, end.index + end[0].length) + '\nreturn legacyHighRiskScan;')();
}

// ── fixtures ────────────────────────────────────────────────────────────────
const STATUS_SOLD = { entity_type: 'estimate', entity_id: EST, ops: { field_updates: { status: 'sold' } } };

const FIXTURES = {
  // incident + wrappers
  incident: { door: true, risk: 'high', targets: [STATUS_SOLD] },
  incidentBulk: { door: true, risk: 'high', targets: [
    { entity_type: 'estimate', bulk: { items: [{ entity_id: EST, ops: { field_updates: { status: 'sold' } } }] } }] },
  incidentBulkItemIsOps: { door: true, risk: 'high', targets: [
    { entity_type: 'estimate', bulk: { items: [{ field_updates: { status: 'sold' } }] } }] },
  incidentMoveDest: { door: true, risk: 'high', targets: [{ op: 'move',
    source: { entity_type: 'lead', entity_id: LEAD, ops: { fields: { gate_code: '2222' } } },
    dest: { entity_type: 'estimate', entity_id: EST, ops: { field_updates: { status: 'sold' } } } }] },
  incidentMoveSource: { door: true, risk: 'high', targets: [{ op: 'move',
    source: { entity_type: 'estimate', entity_id: EST, ops: { field_updates: { status: 'sold' } } },
    dest: { entity_type: 'lead', entity_id: LEAD, ops: { fields: { gate_code: '2222' } } } }] },
  incidentCapitalised: { door: false, risk: 'high', targets: [
    { entity_type: 'Estimate', entity_id: EST, ops: { field_updates: { status: 'sold' } } }] },
  incidentShouting: { door: false, risk: 'high', targets: [
    { entity_type: ' ESTIMATE ', entity_id: EST, ops: { field_updates: { status: 'sold' } } }] },
  jobStage: { door: true, risk: 'high', targets: [
    { entity_type: 'job', entity_id: JOB, ops: { field_updates: { stage: 'closeout' } } }] },
  leadStatus: { door: true, risk: 'high', targets: [
    { entity_type: 'lead', entity_id: LEAD, ops: { fields: { status: 'sold' } } }] },
  coStatus: { door: true, risk: 'high', targets: [{ entity_type: 'job', entity_id: JOB,
    ops: { change_orders: [{ op: 'update', co_id: CO, fields: { status: 'approved' } }] } }] },
  jobState: { door: true, risk: 'high', targets: [
    { entity_type: 'job', entity_id: JOB, ops: { field_updates: { state: 'closed' } } }] },

  // money
  coUnitSell: { door: true, risk: 'high', targets: [{ entity_type: 'job', entity_id: JOB,
    ops: { change_orders: [{ op: 'update', co_id: CO, line_edits: [{ line_id: LINE, unitSell: 1650 }] }] } }] },
  coUnitCostNested: { door: true, risk: 'high', targets: [{ entity_type: 'job', entity_id: JOB,
    ops: { change_orders: [{ op: 'update', co_id: CO, line_edits: [{ line_id: LINE, fields: { unit_cost: 900 } }] }] } }] },
  coLineAdd: { door: true, risk: 'high', targets: [{ entity_type: 'job', entity_id: JOB,
    ops: { change_orders: [{ op: 'update', co_id: CO, line_adds: [{ description: 'Flashing', qty: 1, unitCost: 450 }] }] } }] },
  coCreate: { door: true, risk: 'high', targets: [{ entity_type: 'job', entity_id: JOB,
    ops: { change_orders: [{ op: 'create', fields: { title: 'Owner-requested flashing' } }] } }] },
  estLineUnitCost: { door: true, risk: 'high', targets: [{ entity_type: 'estimate', entity_id: EST,
    ops: { line_edits: [{ line_id: LINE, unitCost: 1350 }] } }] },
  estLineNested: { door: true, risk: 'high', targets: [{ entity_type: 'estimate', entity_id: EST,
    ops: { line_edits: [{ line_id: LINE, fields: { unit_price: 1350 } }] } }] },
  estLineAdds: { door: true, risk: 'high', targets: [{ entity_type: 'estimate', entity_id: EST,
    ops: { line_adds: [{ description: 'Sealant', qty: 10, unit_cost: 12 }, { description: 'Caulk', qty: 4, unitCost: 8 }],
      line_edits: [{ line_id: LINE, unitCost: 1350 }] } }] },
  estTaxRate: { door: true, risk: 'high', targets: [{ entity_type: 'estimate', entity_id: EST,
    ops: { field_updates: { tax_rate: 7.5 } } }] },
  estMarkupPct: { door: true, risk: 'high', targets: [{ entity_type: 'estimate', entity_id: EST,
    ops: { field_updates: { markup_pct: 35 } } }] },
  estAssembly: { door: true, risk: 'high', targets: [{ entity_type: 'estimate', entity_id: EST,
    ops: { assembly_adds: [{ assembly_id: 42, params: { Q: 120 } }] } }] },
  estSectionMarkup: { door: true, risk: 'high', targets: [{ entity_type: 'estimate', entity_id: EST,
    ops: { sections: [{ op: 'update', section_id: SECTION, markup: 20 }] } }] },
  jobPhaseBudget: { door: true, risk: 'high', targets: [{ entity_type: 'job', entity_id: JOB,
    ops: { phase_updates: [{ phase_id: PHASE, materials: 5000 }] } }] },
  jobContract: { door: true, risk: 'high', targets: [{ entity_type: 'job', entity_id: JOB,
    ops: { field_updates: { contractAmount: 275000 } } }] },
  jobRevenueBudget: { door: true, risk: 'high', targets: [{ entity_type: 'job', entity_id: JOB,
    ops: { field_updates: { revisedBudget: 10, projectedRevenue: 20 } } }] },
  invoiceCreate: { door: true, risk: 'high', targets: [{ entity_type: 'job', entity_id: JOB,
    ops: { invoices: [{ op: 'create', fields: { notes: 'Draw 3' } }] } }] },
  invoiceCreateLines: { door: true, risk: 'high', targets: [{ entity_type: 'job', entity_id: JOB,
    ops: { invoices: [{ op: 'create', fields: { lines: [{ description: 'Draw 3', qty: 1, unitPrice: 12000 }], tax_pct: 7 } }] } }] },
  invoiceRetainage: { door: true, risk: 'high', targets: [{ entity_type: 'job', entity_id: JOB,
    ops: { invoices: [{ op: 'update', invoice_id: INV, fields: { retainage_amount: 1200 } }] } }] },
  poLines: { door: true, risk: 'high', targets: [{ entity_type: 'job', entity_id: JOB,
    ops: { purchase_orders: [{ op: 'update', po_id: PO, fields: { lines: [{ description: 'Lumber', qty: 1, unitCost: 900 }] } }] } }] },
  leadRevenue: { door: true, risk: 'high', targets: [{ entity_type: 'lead', entity_id: LEAD,
    ops: { fields: { estimated_revenue_high: 180000 } } }] },
  assemblyItems: { door: true, risk: 'high', targets: [{ entity_type: 'assembly', entity_id: 42,
    ops: { op: 'update', items: [] } }] },
  billAmount: { door: false, risk: 'high', targets: [{ entity_type: 'bill', entity_id: BILL,
    ops: { fields: { amount: 4200 } } }] },
  payAppDraw: { door: false, risk: 'high', targets: [{ entity_type: 'pay_application', entity_id: PAYAPP,
    ops: { fields: { draw_amount: 18000 } } }] },

  // completion, every spelling
  jobAllocPct: { door: true, risk: 'high', targets: [{ entity_type: 'job', entity_id: JOB,
    ops: { field_updates: { allocPct: 50 } } }] },
  estLineMove: { door: true, risk: 'high', targets: [{ entity_type: 'estimate', entity_id: EST,
    ops: { line_edits: [{ line_id: LINE, subgroup_id: SECTION }] } }] },
  estSectionReorder: { door: true, risk: 'high', targets: [{ entity_type: 'estimate', entity_id: EST,
    ops: { sections: [{ op: 'reorder', order: [SECTION] }] } }] },
  delDeletesKey: { door: true, risk: 'high', targets: [{ entity_type: 'estimate', entity_id: EST,
    ops: { field_updates: { photo_deletes: [ATT] } } }] },

  pctPhase: { door: true, risk: 'high', targets: [{ entity_type: 'job', entity_id: JOB,
    ops: { phase_updates: [{ phase_id: PHASE, pct_complete: 100 }] } }] },

  // deletes
  delEstLines: { door: true, risk: 'high', targets: [{ entity_type: 'estimate', entity_id: EST,
    ops: { line_deletes: [{ line_id: LINE }] } }] },
  delEstLinesBare: { door: true, risk: 'high', targets: [{ entity_type: 'estimate', entity_id: EST,
    ops: { line_deletes: [LINE2] } }] },
  delEstSection: { door: true, risk: 'high', targets: [{ entity_type: 'estimate', entity_id: EST,
    ops: { sections: [{ op: 'delete', section_id: SECTION }] } }] },
  delEstGroup: { door: true, risk: 'high', targets: [{ entity_type: 'estimate', entity_id: EST,
    ops: { groups: [{ op: 'delete', group_id: GROUP }] } }] },
  delCo: { door: true, risk: 'high', targets: [{ entity_type: 'job', entity_id: JOB,
    ops: { change_orders: [{ op: 'delete', co_id: CO }] } }] },
  delPo: { door: true, risk: 'high', targets: [{ entity_type: 'job', entity_id: JOB,
    ops: { purchase_orders: [{ op: 'delete', po_id: PO }] } }] },
  delInvoice: { door: true, risk: 'high', targets: [{ entity_type: 'job', entity_id: JOB,
    ops: { invoices: [{ op: 'delete', invoice_id: INV }] } }] },
  delCoLine: { door: true, risk: 'high', targets: [{ entity_type: 'job', entity_id: JOB,
    ops: { change_orders: [{ op: 'update', co_id: CO, line_deletes: [{ line_number: 2 }] }] } }] },
  delSchedule: { door: true, risk: 'high', targets: [{ entity_type: 'schedule',
    ops: { blocks: [{ op: 'delete', entry_id: ENTRY }] } }] },
  delReportSection: { door: true, risk: 'high', targets: [{ entity_type: 'report', entity_id: REPORT,
    ops: { section_deletes: ['sec_1757000000_s1'] } }] },
  delReportReplace: { door: true, risk: 'high', targets: [{ entity_type: 'report', entity_id: REPORT,
    ops: { sections: [{ label: 'Only this one', layout: 'text-block', text_body: 'x' }] } }] },
  delAssembly: { door: true, risk: 'high', targets: [{ entity_type: 'assembly', entity_id: 42, ops: { op: 'delete' } }] },
  delRemoveKey: { door: true, risk: 'high', targets: [{ entity_type: 'estimate', entity_id: EST,
    ops: { field_updates: { remove_all_lines: true } } }] },
  delClientStructure: { door: true, risk: 'high', targets: [{ entity_type: 'client', entity_id: CLIENT,
    ops: { structure: { delete: true } } }] },

  // system / send / unrecognised
  systemLink: { door: true, risk: 'high', targets: [{ entity_type: 'system',
    ops: { link_ops: [{ op: 'link_job_to_client', job_id: JOB, client_id: CLIENT }] } }] },
  systemPackDelete: { door: true, risk: 'high', targets: [{ entity_type: 'system',
    ops: { skill_pack_ops: [{ op: 'delete', pack_id: PACK }] } }] },
  sendEmail: { door: true, risk: 'high', targets: [{ entity_type: 'estimate', entity_id: EST,
    ops: { field_updates: { send_email: true } } }] },
  notifyNotes: { door: true, risk: 'high', targets: [{ entity_type: 'job', entity_id: JOB,
    ops: { notes: [{ body: 'Crew on site Monday', notify_client: true }] } }] },
  estJobLink: { door: true, risk: 'high', targets: [{ entity_type: 'estimate', entity_id: EST,
    ops: { field_updates: { job_id: JOB } } }] },
  estUnknownField: { door: true, risk: 'high', targets: [{ entity_type: 'estimate', entity_id: EST,
    ops: { field_updates: { nickname2: 'FSQ' } } }] },
  estGroupAdd: { door: true, risk: 'high', targets: [{ entity_type: 'estimate', entity_id: EST,
    ops: { groups: [{ op: 'add', name: 'Alt 1' }] } }] },
  retiredWire: { door: false, risk: 'high', targets: [{ entity_type: 'job', entity_id: JOB,
    ops: { wire_updates: [{ from_node_id: 'n1', to_node_id: 'n2', pct_complete: 100 }] } }] },
  unknownType: { door: false, risk: 'high', targets: [{ entity_type: 'widget', entity_id: 'wdg_1757000000_w1',
    ops: { fields: { color: 'red' } } }] },
  leadPhone: { door: false, risk: 'high', targets: [{ entity_type: 'lead', entity_id: LEAD,
    ops: { fields: { phone: '(813) 555-0100' } } }] },
  bulkWithOps: { door: true, risk: 'high', targets: [{ entity_type: 'client', ops: { fields: { phone: '1' } },
    bulk: { items: [{ entity_id: CLIENT, ops: { fields: { city: 'Tampa' } } }] } }] },
  targetOpDelete: { door: true, risk: 'high', targets: [{ op: 'delete', entity_type: 'client', entity_id: CLIENT, ops: {} }] },

  // LOW — the spoken-yes set
  todoCreate: { door: true, risk: 'low', targets: [{ entity_type: 'todo',
    ops: { op: 'create', fields: { title: 'Call the stucco supplier', due_date: '2026-09-14', priority: 'high' } } }] },
  todoLinked: { door: true, risk: 'low', targets: [{ entity_type: 'todo',
    ops: { fields: { title: 'Walk the site', entity_type: 'job', entity_id: JOB } } }] },
  reminderCreate: { door: true, risk: 'low', targets: [{ entity_type: 'reminder',
    ops: { op: 'create', fields: { title: 'Gate code for Smith', remind_at: '2026-09-13T08:00:00' } } }] },
  calendarCreate: { door: true, risk: 'low', targets: [{ entity_type: 'calendar_event',
    ops: { op: 'create', fields: { title: 'Site walk', starts_at: '2026-09-15T09:00:00', location: 'Harbor Point',
      reminder_minutes: 30 } } }] },
  taskCreate: { door: true, risk: 'low', targets: [{ entity_type: 'task',
    ops: { op: 'create', fields: { title: 'Order flashing', due_date: '2026-09-20', kind: 'punch', status: 'open' } } }] },
  clientCreate: { door: true, risk: 'low', targets: [{ entity_type: 'client',
    ops: { fields: { name: 'Bayview HOA', phone: '(727) 555-0142' } } }] },
  clientPhone: { door: true, risk: 'low', targets: [{ entity_type: 'client', entity_id: CLIENT,
    ops: { fields: { phone: '(813) 555-0100' } } }] },
  leadAddress: { door: true, risk: 'low', targets: [{ entity_type: 'lead', entity_id: LEAD,
    ops: { fields: { street_address: '14 New Rd', gate_code: '2222' } } }] },
  leadState: { door: true, risk: 'high', targets: [{ entity_type: 'lead', entity_id: LEAD,
    ops: { fields: { state: 'GA' } } }] },
  leadNotes: { door: true, risk: 'low', targets: [{ entity_type: 'lead', entity_id: LEAD,
    ops: { notes: ['Owner prefers mornings'] } }] },
  photoCaption: { door: true, risk: 'low', targets: [{ entity_type: 'attachment',
    ops: { photo_updates: [{ attachment_id: ATT, caption: 'north wall, after repair' }] } }] },
  photoBatch: { door: true, risk: 'low', targets: [{ entity_type: 'attachment',
    ops: { photo_updates: [{ attachment_id: ATT, caption: 'a' }, { attachment_id: ATT2, tags: ['Framing'] }] } }] },
  dealNote: { door: true, risk: 'low', targets: [{ entity_type: 'deal_memory', entity_id: LEAD,
    ops: { note_adds: [{ text: 'client waived the flashing CO' }], note_supersedes: [{ id: NOTE }] } }] },
  estEmptyDeletes: { door: true, risk: 'low', targets: [{ entity_type: 'estimate', entity_id: EST,
    ops: { line_deletes: [], field_updates: { description: 'Exterior repaint' } } }] },
  estLineWords: { door: true, risk: 'low', targets: [{ entity_type: 'estimate', entity_id: EST,
    ops: { line_edits: [{ line_id: LINE2, description: 'Paint, three coats' }] } }] },
  scheduleCreate: { door: true, risk: 'low', targets: [{ entity_type: 'schedule',
    ops: { blocks: [{ op: 'create', jobId: JOB, startDate: '2026-09-21', days: 3, crew: ['A'] }] } }] },
  ticketCreate: { door: true, risk: 'low', targets: [{ entity_type: 'service_ticket',
    ops: { fields: { title: 'Leak at unit 4', job_id: JOB, scope_proposed: 'Inspect and patch' },
      task_adds: [{ title: 'Inspect roof' }] } }] },
  reportCreate: { door: true, risk: 'low', targets: [{ entity_type: 'report',
    ops: { op: 'create', template_type: 'daily-log', parent_id: PROJECT, title: 'Daily log',
      cover_page: { enabled: true, weather: 'Sunny', hours_on_site: '8' } } }] },
  assemblyHeader: { door: true, risk: 'low', targets: [{ entity_type: 'assembly', entity_id: 42,
    ops: { op: 'update', fields: { description: 'Stucco patch per SF' }, reason: 'sold as a status change' } }] },
};

const JOB_PCT_SPELLINGS = ['pct_complete', 'percent_complete', 'pctComplete', 'complete_pct', 'completion_pct',
  'percentComplete', 'pctCompleteManual', 'progress_pct', 'completionPercent'];
for (const key of JOB_PCT_SPELLINGS) {
  FIXTURES['pctJob_' + key] = { door: true, risk: 'high', targets: [{ entity_type: 'job', entity_id: JOB,
    ops: { field_updates: { [key]: 100 } } }] };
}

// ── loading ─────────────────────────────────────────────────────────────────
describe('payload-describe loads without a JWT_SECRET', () => {
  test('a child node with no JWT_SECRET requires it, and never loads ../auth or the dispatcher', () => {
    const env = Object.assign({}, process.env);
    delete env.JWT_SECRET;
    const script = `
      const m = require(${JSON.stringify(MODULE_PATH)});
      const loaded = Object.keys(require.cache).filter((p) => p !== ${JSON.stringify(MODULE_PATH)});
      const r = m.describePayload([{ entity_type: 'todo', ops: { fields: { title: 'x' } } }], [], {});
      process.stdout.write(JSON.stringify({ type: typeof m.describePayload, loaded: loaded.length, risk: r.risk }));
    `;
    const out = spawnSync(process.execPath, ['-e', script], { env, cwd: ROOT, encoding: 'utf8' });
    expect(out.stderr).toBe('');
    expect(JSON.parse(out.stdout)).toEqual({ type: 'function', loaded: 0, risk: 'low' });
  });
});

// ── fixtures are real ───────────────────────────────────────────────────────
describe('fixtures are the dispatcher\'s own shapes', () => {
  test.each(Object.entries(FIXTURES))('%s — validateTarget agrees with the door flag', (name, fx) => {
    for (const t of fx.targets) expect([name, dispatcherAccepts(t)]).toEqual([name, fx.door]);
  });
  test.each(Object.entries(FIXTURES))('%s — risk', (name, fx) => {
    expect([name, describeIt(fx.targets).risk]).toEqual([name, fx.risk]);
  });
  test.each(Object.entries(FIXTURES))('%s — clickOnly is exactly risk === high', (name, fx) => {
    const r = describeIt(fx.targets);
    expect(r.clickOnly).toBe(r.risk === 'high');
    expect(r.risk === 'high').toBe(r.reasons.length > 0);
  });
});

// ── incident 2026-08-09 ─────────────────────────────────────────────────────
describe('incident: "Convert estimate to job" that set status=sold', () => {
  test('the line says status and sold, from the ops and the changeset, and nothing from the title', () => {
    const r = describeIt([Object.assign({}, STATUS_SOLD, { title: 'Convert estimate to job' })]);
    expect(r.line).toBe('Estimate · Fountain Square — status draft → sold');
    expect(r.line).not.toMatch(/convert/i);
    expect(r.risk).toBe('high');
    expect(r.clickOnly).toBe(true);
    expect(r.reasons).toEqual(['status_change:estimate']);
    expect(r.parts).toEqual([{ entity_type: 'estimate', entity_id: EST,
      fields: [{ key: 'status', before: 'draft', after: 'sold' }],
      counts: { added: 0, edited: 0, deleted: 0 }, reasons: ['status_change:estimate'] }]);
  });

  test('title / summary / rationale / filename / entity_display carrying a lie change nothing', () => {
    const lying = Object.assign({}, STATUS_SOLD, {
      title: 'Convert estimate to job',
      summary: 'Harmless phone fix',
      rationale: 'attempting to drive job creation by updating estimate status',
      filename: 'Lead.lead_1-PhoneFix.2026-09-12.p86.json',
      entity_display: 'Smith Residence phone',
      entity_metadata: { note: 'just a phone number' },
    });
    const plain = describeIt([STATUS_SOLD]);
    const lied = describeIt([lying]);
    expect(lied).toEqual(plain);
    expect(lied.line).not.toMatch(/convert|phone|harmless|drive/i);
  });

  test('a lying title on a LOW change does not make it look like anything else either', () => {
    const t = FIXTURES.clientPhone.targets[0];
    expect(describeIt([Object.assign({}, t, { title: 'Mark estimate sold', summary: 'status sold' })]))
      .toEqual(describeIt([t]));
  });

  test.each(['incidentBulk', 'incidentBulkItemIsOps', 'incidentMoveDest', 'incidentMoveSource',
    'incidentCapitalised', 'incidentShouting'])('%s is high with the estimate status reason', (name) => {
    const r = describeIt(FIXTURES[name].targets);
    expect(r.risk).toBe('high');
    expect(r.reasons).toContain('status_change:estimate');
    expect(r.line).toMatch(/status/);
    expect(r.line).toMatch(/sold/);
    expect(classifyRisk(FIXTURES[name].targets)).toEqual({ risk: 'high', reasons: r.reasons });
  });

  test('the move puts the status change first even when it is the second side', () => {
    expect(describeIt(FIXTURES.incidentMoveDest.targets).line)
      .toBe('Estimate · Fountain Square — status draft → sold; Lead · Smith Residence — gate code 1111 → 2222');
  });

  test('status on other money-bearing records, including a change order inside a job', () => {
    expect(describeIt(FIXTURES.jobStage.targets).reasons).toEqual(['status_change:job']);
    expect(describeIt(FIXTURES.leadStatus.targets).reasons).toEqual(['status_change:lead']);
    expect(describeIt(FIXTURES.coStatus.targets).reasons).toEqual(['status_change:change_order']);
    expect(describeIt(FIXTURES.jobState.targets).reasons).toEqual(['status_change:job']);
  });

  test('`state` is carded on a lead too — John\'s rule and the current gate both name it', () => {
    // LEAD_EDITABLE_FIELDS makes a lead's state the ADDRESS state, so this is a
    // known false "high". It costs one click on a rare edit; an exemption would
    // make this gate looser than isHighRiskPayload, which cards it today.
    const r = describeIt(FIXTURES.leadState.targets);
    expect(r.reasons).toEqual(['status_change:lead']);
    expect(r.line).toBe('Lead · Smith Residence — state FL → GA');
    const low = describeIt(FIXTURES.leadAddress.targets);
    expect(low.risk).toBe('low');
    expect(low.line).toBe('Lead · Smith Residence — street address 12 Old Rd → 14 New Rd, gate code 1111 → 2222');
  });
});

// ── money ───────────────────────────────────────────────────────────────────
describe('money edits are click-only', () => {
  const cases = [
    ['coUnitSell', 'money:unitSell'],
    ['coUnitCostNested', 'money:unit_cost'],
    ['coLineAdd', 'money:unitCost'],
    ['coCreate', 'money:change_orders.create'],
    ['estLineUnitCost', 'money:unitCost'],
    ['estLineNested', 'money:unit_price'],
    ['estTaxRate', 'money:tax_rate'],
    ['estMarkupPct', 'money:markup_pct'],
    ['estAssembly', 'money:assembly_adds'],
    ['estSectionMarkup', 'money:markup'],
    ['jobPhaseBudget', 'money:materials'],
    ['jobContract', 'money:contractAmount'],
    ['jobRevenueBudget', 'money:revisedBudget'],
    ['jobRevenueBudget', 'money:projectedRevenue'],
    ['invoiceCreate', 'money:invoices.create'],
    ['invoiceCreateLines', 'money:lines'],
    ['invoiceCreateLines', 'money:tax_pct'],
    ['invoiceRetainage', 'money:retainage_amount'],
    ['poLines', 'money:lines'],
    ['leadRevenue', 'money:estimated_revenue_high'],
    ['assemblyItems', 'money:items'],
    ['jobAllocPct', 'money:allocPct'],
    ['billAmount', 'money:amount'],
    ['payAppDraw', 'money:draw_amount'],
  ];
  test.each(cases)('%s carries %s', (name, code) => {
    const r = describeIt(FIXTURES[name].targets);
    expect(r.risk).toBe('high');
    expect(r.reasons).toContain(code);
  });

  test('the CO unit sell line names the change order and the new price, never the co_ id', () => {
    expect(describeIt(FIXTURES.coUnitSell.targets).line).toBe('Job · Harbor Point — change order CO-3: unit sell → 1650');
  });

  test('an estimate line edit shows the before price from the changeset and the line it is on', () => {
    expect(describeIt(FIXTURES.estLineUnitCost.targets).line)
      .toBe('Estimate · Fountain Square — unit cost 1200 → 1350 on Stucco patch');
    expect(describeIt(FIXTURES.estLineNested.targets).line)
      .toBe('Estimate · Fountain Square — unit price 1200 → 1350 on Stucco patch');
  });

  test('adds are counted; an edit beside them is still spelled out', () => {
    expect(describeIt(FIXTURES.estLineAdds.targets).line)
      .toBe('Estimate · Fountain Square — 2 lines added, unit cost 1200 → 1350 on Stucco patch');
  });

  test('several line edits collapse into a price count and a word count', () => {
    const r = describeIt([{ entity_type: 'estimate', entity_id: EST, ops: { line_edits: [
      { line_id: LINE, unitCost: 1 }, { line_id: LINE2, qty: 2 }, { line_id: LINE2, description: 'x' }] } }]);
    expect(r.line).toBe('Estimate · Fountain Square — 2 prices changed, 1 line edited');
    expect(r.reasons).toEqual(['money:unitCost', 'money:qty']);
  });

  test('a job phase budget shows the phase by its stored name', () => {
    expect(describeIt(FIXTURES.jobPhaseBudget.targets).line)
      .toBe('Job · Harbor Point — materials 1000 → 5000 on Framing');
  });

  test('an invoice create is money even when its fields name no amount', () => {
    const r = describeIt(FIXTURES.invoiceCreate.targets);
    expect(r.reasons).toEqual(['money:invoices.create']);
    expect(r.line).toBe('Job · Harbor Point — invoice created');
  });

  test('a door that does not exist yet (bill, pay application) is unrecognized AND money', () => {
    for (const name of ['billAmount', 'payAppDraw']) {
      const r = describeIt(FIXTURES[name].targets);
      expect(r.reasons).toContain('unrecognized');
      expect(r.line.startsWith('Unrecognized change — ')).toBe(true);
      expect(r.line).toMatch(/money field/);
    }
  });

  test('a non-money contact change is low and reads before → after', () => {
    const r = describeIt(FIXTURES.clientPhone.targets);
    expect(r.risk).toBe('low');
    expect(r.reasons).toEqual([]);
    expect(r.line).toBe('Client · Acme HOA — phone (813) 555-0199 → (813) 555-0100');
  });

  test('a lead has no phone column: that key is refused by the dispatcher and unrecognized here', () => {
    const r = describeIt(FIXTURES.leadPhone.targets);
    expect(r.reasons).toContain('unrecognized');
  });
});

// ── completion ──────────────────────────────────────────────────────────────
describe('completion % under every spelling is click-only', () => {
  test.each(JOB_PCT_SPELLINGS)('job field_updates.%s', (key) => {
    const r = describeIt(FIXTURES['pctJob_' + key].targets);
    expect(r.risk).toBe('high');
    expect(r.reasons).toContain('completion:' + key);
    expect(r.reasons.some((c) => c.indexOf('money:') === 0)).toBe(false);
  });

  test('phase_updates.pct_complete reads as % complete with the stored before value', () => {
    const r = describeIt(FIXTURES.pctPhase.targets);
    expect(r.reasons).toEqual(['completion:pct_complete']);
    expect(r.line).toBe('Job · Harbor Point — % complete 40 → 100 on Framing');
  });

  test('completion inside a retired op, a bulk job item and a nested object is still caught', () => {
    expect(describeIt(FIXTURES.retiredWire.targets).reasons).toContain('completion:pct_complete');
    expect(describeIt([{ entity_type: 'job', bulk: { items: [{ entity_id: JOB, ops: { phase_updates: [
      { phase_id: PHASE, pct_complete: 90 }] } }] } }]).reasons).toContain('completion:pct_complete');
    expect(describeIt([{ entity_type: 'job', entity_id: JOB, ops: { field_updates: {
      schedule: { percentComplete: 50 } } } }]).reasons).toContain('completion:percentComplete');
  });
});

// ── deletes ─────────────────────────────────────────────────────────────────
describe('deletes of every shape are click-only', () => {
  const cases = [
    ['delEstLines', 'delete:line_deletes', 'Estimate · Fountain Square — 1 line deleted'],
    ['delEstLinesBare', 'delete:line_deletes', 'Estimate · Fountain Square — 1 line deleted'],
    ['delEstSection', 'delete:sections', 'Estimate · Fountain Square — 1 section deleted'],
    ['delEstGroup', 'delete:groups', 'Estimate · Fountain Square — 1 scope deleted'],
    ['delCo', 'delete:change_orders', 'Job · Harbor Point — change order CO-3 deleted'],
    ['delPo', 'delete:purchase_orders', 'Job · Harbor Point — purchase order deleted'],
    ['delInvoice', 'delete:invoices', 'Job · Harbor Point — invoice deleted'],
    ['delCoLine', 'delete:line_deletes', 'Job · Harbor Point — change order CO-3: 1 line deleted'],
    ['delSchedule', 'delete:blocks', 'Schedule — 1 schedule entry deleted'],
    ['delReportSection', 'delete:section_deletes', 'Report — 1 section deleted'],
    ['delReportReplace', 'delete:sections', 'Report — all sections replaced (1)'],
    ['delAssembly', 'delete:op', 'Assembly — assembly deleted'],
    ['delRemoveKey', 'delete:remove_all_lines', null],
    ['delDeletesKey', 'delete:photo_deletes', null],
    ['delClientStructure', 'delete:delete', null],
    ['systemPackDelete', 'delete:skill_pack_ops', null],
    ['targetOpDelete', 'delete:target.op', null],
  ];
  test.each(cases)('%s carries %s', (name, code, line) => {
    const r = describeIt(FIXTURES[name].targets);
    expect(r.risk).toBe('high');
    expect(r.reasons).toContain(code);
    if (line) expect(r.line).toBe(line);
  });

  test('a delete_* / remove_* key is named in the line even though no handler models it', () => {
    expect(describeIt(FIXTURES.delRemoveKey.targets).line).toMatch(/remove all lines/);
  });

  test('an EMPTY line_deletes deletes nothing and is not a delete', () => {
    const r = describeIt(FIXTURES.estEmptyDeletes.targets);
    expect(r.risk).toBe('low');
    expect(r.line).toBe('Estimate · Fountain Square — description (blank) → Exterior repaint');
  });

  test('a delete buried where the structured walk writes only a count still gets its own phrase', () => {
    const r = describeIt([{ entity_type: 'report', entity_id: REPORT, ops: { cover_page: { purge_photos: true } } }]);
    expect(r.reasons).toEqual(expect.arrayContaining(['delete:purge_photos']));
    expect(r.line).toMatch(/delete \(purge photos\)/);
  });
});

// ── system / sends / unrecognised ───────────────────────────────────────────
describe('system targets, outbound sends and anything unrecognised', () => {
  test('a system target is high even when it deletes nothing', () => {
    const r = describeIt(FIXTURES.systemLink.targets);
    expect(r.reasons).toEqual(['system']);
    expect(r.line).toBe('System — system change');
  });

  test('outbound send keys, including one hidden in a job note object', () => {
    expect(describeIt(FIXTURES.sendEmail.targets).reasons).toContain('send:send_email');
    const hidden = describeIt(FIXTURES.notifyNotes.targets);
    expect(hidden.reasons).toEqual(['send:notify_client']);
    expect(hidden.line).toBe('Job · Harbor Point — outbound send (notify client), 1 note added');
  });

  test('contact email fields are addresses, not sends', () => {
    const r = describeIt([{ entity_type: 'client', entity_id: CLIENT, ops: { fields: {
      email: 'a@b.co', cm_email: 'c@d.co', mm_email: 'e@f.co' } } }]);
    expect(r.risk).toBe('low');
  });

  test('re-linking an estimate to a job is click-only and never prints the job id', () => {
    const r = describeIt(FIXTURES.estJobLink.targets);
    expect(r.reasons).toEqual(['link:job_id']);
    expect(r.line).toBe('Estimate · Fountain Square — job → Harbor Point');
  });

  test('a group add can zero an estimate total, so it is structure', () => {
    expect(describeIt(FIXTURES.estGroupAdd.targets).reasons).toEqual(['structure:groups.add']);
  });

  test('unknown field, unknown op key, unknown entity type, unknown operation', () => {
    expect(describeIt(FIXTURES.estUnknownField.targets).reasons)
      .toEqual(['unrecognized', 'unrecognized:field_updates.nickname2']);
    expect(describeIt([{ entity_type: 'estimate', entity_id: EST, ops: { frobnicate: 1 } }]).reasons)
      .toContain('unrecognized:ops.frobnicate');
    const w = describeIt(FIXTURES.unknownType.targets);
    expect(w.reasons).toContain('unrecognized');
    expect(w.line).toBe('Unrecognized change — unrecognized change');
    expect(describeIt([{ entity_type: 'todo', ops: { op: 'update', fields: { title: 'x' } } }]).reasons)
      .toContain('unrecognized:ops.op');
    expect(describeIt([{ entity_type: 'job', entity_id: JOB, ops: { change_orders: [{ op: 'approve', co_id: CO }] } }]).reasons)
      .toContain('unrecognized:change_orders[0].op');
  });

  test('an unknown entity_type is never echoed into the line', () => {
    const r = describeIt([{ entity_type: 'Convert estimate to job', ops: { fields: { name: 'x' } } }]);
    expect(r.line).not.toMatch(/convert/i);
    expect(r.risk).toBe('high');
  });

  test.each([
    ['not json', 'not json'],
    ['a JSON object', '{"targets":[]}'],
    ['an empty array', []],
    ['null', null],
    ['a number', 7],
    ['an array holding a string', ['estimate']],
    ['ops that is a string', [{ entity_type: 'estimate', entity_id: EST, ops: 'field_updates' }]],
    ['field_updates that is an array', [{ entity_type: 'estimate', entity_id: EST, ops: { field_updates: ['status'] } }]],
    ['bulk with no items', [{ entity_type: 'estimate', bulk: {} }]],
    ['bulk item that is a string', [{ entity_type: 'todo', bulk: { items: ['x'] } }]],
    ['a move with no dest', [{ op: 'move', source: { entity_type: 'todo', ops: { fields: { title: 'x' } } } }]],
    ['an unknown condition', [{ entity_type: 'client', entity_id: CLIENT, condition: 'when_convenient', ops: { fields: { city: 'x' } } }]],
    ['a stray target key', [{ entity_type: 'client', entity_id: CLIENT, status: 'sold', ops: { fields: { city: 'x' } } }]],
    ['a stray bulk item key', [{ entity_type: 'client', bulk: { items: [{ entity_id: CLIENT, ops: { fields: { city: 'x' } }, status: 'sold' }] } }]],
  ])('%s is high/unrecognized', (_label, targets) => {
    const r = describePayload(targets, CHANGESET, { nameFor });
    expect(r.risk).toBe('high');
    expect(r.reasons).toContain('unrecognized');
    expect(classifyRisk(targets).risk).toBe('high');
  });

  test('bulk beside ops is two addresses for one write — runTarget silently drops the ops', () => {
    expect(describeIt(FIXTURES.bulkWithOps.targets).reasons).toContain('unrecognized:targets[0].ops_beside_bulk');
  });

  test('a nested move side and a runaway nesting are refused rather than walked forever', () => {
    let t = { entity_type: 'todo', ops: { fields: { title: 'x' } } };
    for (let i = 0; i < 6; i++) t = { op: 'move', source: t, dest: { entity_type: 'todo', ops: { fields: { title: 'y' } } } };
    const r = describeIt([t]);
    expect(r.risk).toBe('high');
    expect(r.reasons).toContain('unrecognized:targets[0].source.form');
    expect(r.reasons.some((c) => /:too_deep$/.test(c))).toBe(true);
    let deep = { city: 'x' };
    for (let i = 0; i < 40; i++) deep = { a: deep };
    expect(describeIt([{ entity_type: 'job', entity_id: JOB, ops: { field_updates: { schedule: deep } } }]).reasons)
      .toContain('unrecognized:too_deep');
  });

  test('line edits that MOVE or REORDER sections are structure, not words', () => {
    const move = describeIt(FIXTURES.estLineMove.targets);
    expect(move.reasons).toEqual(['structure:subgroup_id']);
    expect(move.line).toBe('Estimate · Fountain Square — line moved to another section');
    expect(describeIt(FIXTURES.estSectionReorder.targets).reasons).toEqual(['structure:sections.reorder']);
  });

  test('targets stored as a JSON string (a payload row) are read the same', () => {
    expect(describeIt(JSON.stringify(FIXTURES.incident.targets))).toEqual(describeIt(FIXTURES.incident.targets));
  });
});

// ── low ─────────────────────────────────────────────────────────────────────
describe('personal and ordinary writes stay low', () => {
  test.each([
    ['todoCreate', 'New to-do — title Call the stucco supplier, due date 2026-09-14, priority high'],
    ['clientCreate', 'New client — name Bayview HOA, phone (727) 555-0142'],
    ['todoLinked', 'New to-do — title Walk the site, linked to job Harbor Point'],
    ['reminderCreate', 'New reminder — title Gate code for Smith, remind at 2026-09-13T08:00:00'],
    ['calendarCreate', 'New calendar event — title Site walk, starts at 2026-09-15T09:00:00, location Harbor Point, reminder minutes 30'],
    ['taskCreate', 'New task — title Order flashing, due date 2026-09-20, kind punch, status open'],
    ['leadNotes', 'Lead · Smith Residence — 1 note added'],
    ['photoCaption', 'Photos — caption north wall → north wall, after repair'],
    ['photoBatch', 'Photos — 1 photo description updated, 1 photo tag set updated'],
    ['dealNote', 'Deal memory — 1 memory note added, 1 memory note retired'],
    ['estLineWords', 'Estimate · Fountain Square — description Paint, two coats → Paint, three coats'],
    ['scheduleCreate', 'Schedule — 1 schedule entry added'],
    ['ticketCreate', 'New service ticket — title Leak at unit 4, job Harbor Point, scope proposed Inspect and patch, 1 task added'],
    ['reportCreate', 'New report — template type daily-log, title Daily log, project Bayview Towers, cover page set'],
    ['assemblyHeader', 'Assembly — description → Stucco patch per SF'],
  ])('%s', (name, line) => {
    const r = describeIt(FIXTURES[name].targets);
    expect(r).toMatchObject({ risk: 'low', clickOnly: false, reasons: [] });
    expect(r.line).toBe(line);
  });

  test('an assembly `reason` is model prose: recognised, never printed', () => {
    expect(describeIt(FIXTURES.assemblyHeader.targets).line).not.toMatch(/sold|status/);
  });
});

// ── the line ────────────────────────────────────────────────────────────────
describe('the line', () => {
  const fixtureEntries = Object.entries(FIXTURES);

  test('no raw id appears in any fixture\'s line — with names, without names, and with a nameFor that echoes ids', () => {
    const lookups = [nameFor, () => null, (_t, id) => String(id), () => { throw new Error('db down'); }];
    for (const lookup of lookups) {
      for (const [name, fx] of fixtureEntries) {
        const { line } = describePayload(fx.targets, CHANGESET, { nameFor: lookup });
        for (const id of ALL_IDS) expect([name, id, line.includes(id)]).toEqual([name, id, false]);
      }
    }
  });

  test('without a name the entity type stands alone', () => {
    expect(describePayload(FIXTURES.incident.targets, CHANGESET, {}).line).toBe('Estimate — status draft → sold');
    expect(describePayload(FIXTURES.coUnitSell.targets, [], { nameFor: () => null }).line)
      .toBe('Job — change order: unit sell → 1650');
    expect(describePayload(FIXTURES.estJobLink.targets, CHANGESET, {}).line).toBe('Estimate — job changed');
  });

  test('a name the caller chose to print survives the id scrub (a job addressed by its number)', () => {
    const r = describePayload([{ entity_type: 'job', entity_id: '2024-017', ops: { field_updates: { pm: 'Jordan' } } }], [],
      { nameFor: (t, id) => (t === 'job' && id === '2024-017' ? '2024-017 Harbor Point' : null) });
    expect(r.line).toBe('Job · 2024-017 Harbor Point — pm → Jordan');
  });

  test('a blob entity\'s before value comes from data, not a same-named column (jobs.client_id)', () => {
    const r = describeIt([{ entity_type: 'job', entity_id: JOB, ops: { field_updates: { client_id: CLIENT } } }]);
    expect(r.parts[0].fields).toEqual([{ key: 'client_id', before: 'client_blob_value', after: CLIENT }]);
    expect(r.line).toBe('Job · Harbor Point — client → Acme HOA');
  });

  test('an id pasted into a value is cut out of the line', () => {
    const r = describeIt([{ entity_type: 'client', entity_id: CLIENT, ops: { fields: { notes: `dup of ${EST}` } } }]);
    expect(r.line).not.toContain(EST);
    expect(r.line).toBe('Client · Acme HOA — notes (blank) → dup of …');
  });

  test(`values are cut at ${VALUE_CAP} characters, and a notes body is never printed whole`, () => {
    const body = 'The owner called about the gutter on the north elevation and wants it priced before Friday. '.repeat(5);
    const r = describeIt([{ entity_type: 'lead', entity_id: LEAD, ops: { fields: { notes: body } } }]);
    expect(r.line).toBe(`Lead · Smith Residence — notes (blank) → ${body.slice(0, VALUE_CAP - 1)}…`);
    expect(r.parts[0].fields[0].after).toBe(body);
  });

  test('the click-only part leads, and "+N more" never hides it', () => {
    const lowFields = { city: 'Clearwater', zip: '33755', website: 'acme.example', gate_code: '4455', short_name: 'ACME',
      market: 'Tampa', cell: '813 555 0101', name: 'Acme Homeowners Association of Tampa Bay', company_name: 'Acme Holdings' };
    const r = describeIt([{ entity_type: 'client', entity_id: CLIENT, ops: { fields: lowFields } }, STATUS_SOLD]);
    expect(r.line.startsWith('Estimate · Fountain Square — status draft → sold; Client · Acme HOA — ')).toBe(true);
    expect(r.line).toMatch(/ \+\d+ more$/);
  });

  test('click-only phrases are never budgeted: ten money edits all print, with nothing hidden', () => {
    const money = { contractAmount: 1, revisedBudget: 2, projectedRevenue: 3, estimatedCosts: 4, targetMarginPct: 5,
      feesAmount: 6, taxRate: 7, retainageAmount: 8, depositAmount: 9, allowanceTotal: 10 };
    const r = describeIt([{ entity_type: 'job', entity_id: JOB, ops: { field_updates: money } }]);
    expect(r.line.length).toBeGreaterThan(160);
    for (const label of ['contract amount', 'revised budget', 'projected revenue', 'estimated costs', 'target margin pct',
      'fees amount', 'tax rate', 'retainage amount', 'deposit amount', 'allowance total']) {
      expect([label, r.line.includes(label)]).toEqual([label, true]);
    }
    expect(r.line).not.toMatch(/more$/);
  });

  test('a click-only field at the END of a long field list is still in the line', () => {
    const fields = { description: 'Exterior repaint of all twelve buildings, phase two',
      address: '1 Harbor Way, Tampa FL 33602', contact_name: 'Pat Doe', contact_email: 'pat@x.co',
      phone: '813 555 0100', market: 'Tampa', salesperson: 'Jordan', units_label: 'units', job_name: 'Harbor', status: 'sold' };
    const r = describeIt([{ entity_type: 'estimate', entity_id: EST, ops: { field_updates: fields } }]);
    expect(r.line.startsWith('Estimate · Fountain Square — status draft → sold, ')).toBe(true);
    expect(r.line).toMatch(/ \+\d+ more$/);
  });

  test('every click-only reason family is visible as words in the line', () => {
    // The words a reader needs to see for each family. Money is checked by the
    // targeted tests above: its phrases are as varied as the fields.
    const WORDS = {
      status_change: /status|stage|state/,
      completion: /% complete/,
      delete: /delet|replaced|remove|purge/,
      send: /send/,
      system: /system change/,
      unrecognized: /unrecognized/i,
      link: /→|re-link/,
      structure: /structure|scope|section/,
    };
    let checked = 0;
    for (const [name, fx] of fixtureEntries) {
      const r = describeIt(fx.targets);
      for (const code of r.reasons) {
        const re = WORDS[code.split(':')[0]];
        if (!re) continue;
        checked++;
        expect([name, code, re.test(r.line)]).toEqual([name, code, true]);
      }
    }
    expect(checked).toBeGreaterThan(60);
  });

  test('a target-level op:"delete" is named as a delete, not only as a bad shape', () => {
    expect(describeIt(FIXTURES.targetOpDelete.targets).line)
      .toBe('Client · Acme HOA — unrecognized target shape, delete (op)');
  });

  test('a record the line already shows as money is not repeated key by key; one that does not is', () => {
    expect(describeIt(FIXTURES.invoiceCreateLines.targets).line).toBe('Job · Harbor Point — invoice created');
    expect(describeIt(FIXTURES.coLineAdd.targets).line).toBe('Job · Harbor Point — change order CO-3: 1 line added');
    expect(describeIt(FIXTURES.estSectionMarkup.targets).line)
      .toBe('Estimate · Fountain Square — 1 section updated, money field markup');
  });
});

// ── agreement with the dispatcher and the current gate ──────────────────────
describe('agreement', () => {
  test('ENTITY_TOP_KEYS is exactly PAYLOAD_OPS_SCHEMAS — a new dispatcher op key must be taught here', () => {
    const fromDispatcher = {};
    for (const [type, schema] of Object.entries(dispatcher.PAYLOAD_OPS_SCHEMAS)) {
      fromDispatcher[type] = [...schema.allowedTopKeys].sort();
    }
    const here = {};
    for (const [type, keys] of Object.entries(ENTITY_TOP_KEYS)) here[type] = [...keys].sort();
    expect(here).toEqual(fromDispatcher);
  });

  test('every column the dispatcher lets a payload write is RECOGNISED (never "unrecognized")', () => {
    const { internals } = dispatcher;
    const sets = [
      ['client', internals.CLIENT_EDITABLE_FIELDS, (f) => ({ entity_type: 'client', entity_id: CLIENT, ops: { fields: f } })],
      ['estimate', internals.ESTIMATE_FIELD_KEYS, (f) => ({ entity_type: 'estimate', entity_id: EST, ops: { field_updates: f } })],
      ['task', internals.TASK_FIELDS, (f) => ({ entity_type: 'task', ops: { fields: f } })],
      ['todo', internals.TODO_FIELDS, (f) => ({ entity_type: 'todo', ops: { fields: f } })],
      ['reminder', internals.REMINDER_FIELDS, (f) => ({ entity_type: 'reminder', ops: { fields: f } })],
      ['service_ticket', internals.SERVICE_TICKET_FIELDS, (f) => ({ entity_type: 'service_ticket', ops: { fields: f } })],
    ];
    for (const [type, set, build] of sets) {
      expect([type, set instanceof Set && set.size > 0]).toEqual([type, true]);
      for (const key of set) {
        const r = classifyRisk([build({ [key]: 'x' })]);
        expect([type, key, r.reasons.includes('unrecognized')]).toEqual([type, key, false]);
      }
    }
  });

  test('nothing the current isHighRiskPayload cards is called low here', () => {
    const isHighRiskPayload = liftIsHighRiskPayload();
    // The lift is real: it cards a known-high payload and passes a known-low one.
    expect(isHighRiskPayload({ targets: FIXTURES.delCo.targets })).toBe(true);
    expect(isHighRiskPayload({ targets: FIXTURES.todoCreate.targets })).toBe(false);
    for (const [name, fx] of Object.entries(FIXTURES)) {
      if (isHighRiskPayload({ targets: fx.targets })) {
        expect([name, classifyRisk(fx.targets).risk]).toEqual([name, 'high']);
      }
    }
  });

  test('classifyRisk is describePayload\'s verdict, independent of names and changeset', () => {
    for (const [name, fx] of Object.entries(FIXTURES)) {
      const d = describeIt(fx.targets);
      expect([name, classifyRisk(fx.targets)]).toEqual([name, { risk: d.risk, reasons: d.reasons }]);
    }
  });
});
