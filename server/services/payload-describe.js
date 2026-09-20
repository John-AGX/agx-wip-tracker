'use strict';

// payload-describe.js — ONE human line and a click-only verdict for an AI
// write payload, derived from the ops and nothing else.
//
// WHY THIS EXISTS (John, 2026-09-12): approving an AI write should be one line
// and one Approve button, and a spoken "yes" should apply a LOW-risk change
// with no card at all. That only works if the line is true and the verdict
// cannot be talked around. Two incidents set the rules this file keeps:
//
//  1. 2026-08-09. A payload TITLED "Convert estimate to job" carried one op —
//     estimate field_updates {status:'sold'} — and AUTO-APPLIED. The title said
//     one thing and the ops did another. So this module never reads title,
//     summary, rationale, filename, entity_display or entity_metadata. They are
//     recognised only so they can be skipped. The line is built from op KEYS,
//     op VALUES (the change itself), the dry-run changeset's BEFORE values and
//     the caller's nameFor() (the database). A model that lies in prose cannot
//     move a word of it.
//
//  2. isHighRiskPayload (routes/payload-routes.js) stringifies only t.ops and
//     matches entity_type case-sensitively, so the SAME status change inside
//     bulk.items[].ops, a move source/dest, or entity_type 'Estimate' reads as
//     harmless there. This walks every place runTarget() in
//     payload-dispatcher.js executes ops from: target.ops, bulk.items[].ops
//     (and an item that IS its own ops — runTarget's `item.ops || item`), and
//     both move sides. `condition` has no branches of its own (upsert only
//     rewrites ops.op), so there is nothing further to walk.
//
// JOHN'S CLICK-ONLY RULES — never approvable by voice:
//   any delete; status/stage/state on money-bearing entities; money edits
//   (price, cost, amount, markup, tax, retainage, budget, revenue, contract…);
//   completion %; system targets; outbound sends; anything unrecognised.
//   When unsure whether something is money it is CLICK-ONLY: a false "high"
//   costs a click, a false "low" costs money.
//
// TWO LAYERS, DELIBERATELY REDUNDANT.
//   • The STRUCTURED WALK knows every op shape the dispatcher executes, per
//     entity type. It writes the line, and anything it does not recognise —
//     an entity type, an op key, a field, an operation — is 'unrecognized'.
//   • The KEY SWEEP reads every KEY under every ops object, at any depth, and
//     applies the delete / send / completion / money / status rules with no
//     knowledge of shape. It exists so a click-only key hidden somewhere the
//     structured walk does not model (a cover page, a v2 `structure` object,
//     an entity type that has no door yet) still makes the payload high.
//   A reason found only by the sweep still gets its own phrase in the line, so
//   the thing that made it click-only is never invisible.
//
// PURE. No require() at all — not the dispatcher, not ../auth, not the db.
// routes/* require ../auth, which throws without a 32-char JWT_SECRET, and
// isHighRiskPayload is meant to delegate HERE; logic that cannot load in a
// JWT-free test is logic that only gets tested where the secret happens to be
// set (test/agent-write-org-scope.test.js, memory "pure logic -> services/").
// The caller resolves names from the DB and passes nameFor(); this module
// never queries.

// ── bounds ──────────────────────────────────────────────────────────────────
// The line is spoken and fits a one-line card. Risky phrases are exempt from
// the budget — "+N more" must never be what hides the change that needed a click.
const LINE_BUDGET = 160;
// A value is shown, never a body: a notes field or a scope of work is cut here.
const VALUE_CAP = 40;
const NAME_CAP = 40;
const KEY_CAP = 24;
// move → side → move … is not a form the dispatcher runs; bound the recursion
// so a hostile nesting cannot hang the approval path.
const MAX_TARGET_DEPTH = 3;
const MAX_SWEEP_DEPTH = 24;

// Model-authored prose a target may carry. Recognised so it is not
// "unrecognized" — and never read. See incident 1.
const FREE_TEXT_KEYS = new Set([
  'title', 'summary', 'rationale', 'filename', 'entity_display', 'entity_metadata',
]);

// Entities whose lifecycle moves money: "sold" puts an estimate in the
// pipeline, "paid" closes AR, "complete" moves a job. isHighRiskPayload's list,
// plus the spellings a pay application or vendor bill door would plausibly use
// — an entity type with no door today is still recognised as money-bearing if
// one appears before this file learns it.
const MONEY_BEARING = new Set([
  'estimate', 'job', 'lead', 'invoice', 'purchase_order', 'change_order',
  'bill', 'vendor_bill', 'pay_app', 'payapp', 'pay_application',
]);

// Record arrays inside job ops, and the money-bearing record each one holds —
// so `change_orders[].fields.status` reads as a CHANGE ORDER status change.
const CONTAINER_TYPES = {
  change_orders: 'change_order', purchase_orders: 'purchase_order', invoices: 'invoice',
};

const CONDITIONS = new Set(['if_exists', 'if_missing', 'upsert']);
const OP_KEYS = new Set(['op', 'action', 'operation']);
const DELETE_OP_VALUES = new Set([
  'delete', 'remove', 'destroy', 'purge', 'erase', 'wipe', 'archive', 'void', 'trash',
]);

// ── key vocabulary ──────────────────────────────────────────────────────────
// Matched on TOKENS (unitSell → unit, sell; retainage_amount → retainage,
// amount), never on substrings, so `contractor_name` is not "contract" and
// `feedback` is not "fee". A single run-together token (`unitcost`) is also
// checked against a short substring list below, because that spelling has no
// boundary to split on.
const MONEY_TOKENS = new Set([
  'price', 'prices', 'pricing', 'priced', 'cost', 'costs', 'costing', 'costed',
  'amount', 'amounts', 'amt', 'markup', 'markups', 'margin', 'margins',
  'tax', 'taxes', 'taxable', 'retainage', 'retain', 'retained', 'retention',
  'budget', 'budgets', 'budgeted', 'revenue', 'revenues', 'contract', 'contracts',
  'income', 'sell', 'selling', 'fee', 'fees', 'discount', 'discounts',
  'total', 'totals', 'subtotal', 'subtotals', 'rate', 'rates',
  'dollar', 'dollars', 'usd', 'money', 'pay', 'payment', 'payments', 'paid',
  'payable', 'receivable', 'balance', 'balances', 'draw', 'draws', 'billing',
  'billed', 'invoice', 'invoiced', 'deposit', 'deposits', 'credit', 'credits',
  'refund', 'refunds', 'wage', 'wages', 'hourly', 'commission', 'allowance',
  'allowances', 'profit', 'overhead', 'contingency', 'value', 'values',
  // qty × unit cost IS the amount; a rollup weight decides whose money counts;
  // a lead's confidence weights the pipeline forecast.
  'qty', 'quantity', 'quantities', 'weight', 'weights', 'confidence',
]);
const MONEY_RUNTOGETHER = /(price|cost|amount|markup|margin|retainage|budget|revenue|income|subtotal|discount|payment|unitsell|sellprice|taxrate|taxpct)/;
const STATUS_TOKENS = new Set(['status', 'statuses', 'stage', 'stages', 'state', 'states', 'lifecycle']);
const SEND_TOKENS = new Set([
  'send', 'sends', 'sent', 'resend', 'notify', 'notifies', 'notification', 'notifications',
  'outbound', 'sms', 'mms', 'mail', 'recipient', 'recipients', 'bcc', 'cc',
]);
const DELETE_LEAD_TOKENS = new Set(['delete', 'remove', 'destroy', 'purge', 'erase', 'wipe']);
const DELETE_TAIL_TOKENS = new Set(['deletes', 'removes', 'deletions', 'removals']);
// Completion is THE driver of the cost model (John, 2026-08-11): earned revenue,
// WIP and over/under billing all derive from it. It has lived on phases, wires,
// nodes and scopes under many spellings, so it is matched by shape, not by list.
const COMPLETION_WORDS = new Set([
  'complete', 'completed', 'completion', 'iscomplete', 'iscompleted', 'markcomplete',
  'progress', 'pctdone', 'percentdone',
]);

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function isRef(v) {
  return typeof v === 'string' && v.length > 1 && v.charAt(0) === '$';
}

// Case-insensitive AND trimmed. The dispatcher looks entity types up exactly,
// so 'Estimate' is refused at apply today — but a classifier that answers
// "harmless" for it is one refactor (a lowercase before dispatch) away from
// auto-applying the incident again. Classify what the type MEANS.
function normType(v) {
  return typeof v === 'string' ? v.trim().toLowerCase() : '';
}

function keyTokens(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function compactKey(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function present(v) {
  if (v == null || v === false || v === 0 || v === '') return false;
  if (Array.isArray(v)) return v.length > 0;
  if (isPlainObject(v)) return Object.keys(v).length > 0;
  if (typeof v === 'string') return v.trim() !== '';
  return true;
}

function isPctKey(tokens, c) {
  return tokens.some((t) => t === 'pct' || t === 'percent' || t === 'percentage' || t === 'pcnt' || t === 'perc')
    || /pct$|^pct|percent/.test(c);
}

function isCompletionKey(tokens, c) {
  if (COMPLETION_WORDS.has(c)) return true;
  return /complet|progress/.test(c) && isPctKey(tokens, c);
}

// Every percentage that is not completion is treated as money: markup_pct,
// discount_pct, tax_pct, allocPct all move a number somebody is paid.
function isMoneyKey(tokens, c) {
  if (tokens.some((t) => MONEY_TOKENS.has(t))) return true;
  if (tokens.length === 1 && MONEY_RUNTOGETHER.test(c)) return true;
  return isPctKey(tokens, c);
}

// `email`, `cm_email`, `contact_email` are ADDRESSES (last token), not sends.
// `email_body`, `email_to`, `send_email` are sends.
function isSendKey(tokens, c) {
  if (tokens.some((t) => SEND_TOKENS.has(t))) return true;
  const i = tokens.indexOf('email');
  if (i >= 0 && i < tokens.length - 1) return true;
  return /textmessage|sendemail|mailsend/.test(c);
}

// A delete needs a VALUE: `line_deletes: []` deletes nothing, and treating it
// as a delete would card every payload that carries an empty array.
function isDeleteKey(tokens, value) {
  if (!tokens.length) return false;
  const hit = DELETE_LEAD_TOKENS.has(tokens[0]) || DELETE_TAIL_TOKENS.has(tokens[tokens.length - 1]);
  return hit && present(value);
}

function isIdKey(key) {
  const t = keyTokens(key);
  const last = t[t.length - 1];
  return t.length > 0 && (last === 'id' || last === 'ids');
}

function codeKey(key) {
  return String(key).slice(0, 64);
}

// The shape-blind rules, shared by both layers so the same key yields the same
// reason code wherever it is found (which is what lets the line account for it).
function keyRiskCodes(key, value, entityCtx) {
  const tokens = keyTokens(key);
  const c = compactKey(key);
  const codes = [];
  if (!tokens.length) return codes;
  if (isSendKey(tokens, c)) codes.push('send:' + codeKey(key));
  if (isDeleteKey(tokens, value)) codes.push('delete:' + codeKey(key));
  if (isCompletionKey(tokens, c)) codes.push('completion:' + codeKey(key));
  // An id is an ADDRESS, not an amount: invoice_id and pay_application_id name
  // a record. Whether pointing at a different one matters is the link rule's
  // question, asked where the key is a field (bagKeyCodes), not here.
  else if (!isIdKey(key) && isMoneyKey(tokens, c)) codes.push('money:' + codeKey(key));
  // `state` included, on EVERY money-bearing entity — a lead's too, although
  // LEAD_EDITABLE_FIELDS lists it as the address state between city and zip.
  // John's rule names status / stage / state, and isHighRiskPayload cards it
  // today; an exemption here would make the new gate looser than the old one
  // for the price of saving one click on a rare edit.
  if (MONEY_BEARING.has(entityCtx) && tokens.some((t) => STATUS_TOKENS.has(t))) {
    codes.push('status_change:' + entityCtx);
  }
  return codes;
}

// ── field bags ──────────────────────────────────────────────────────────────
// low      keys known to be ordinary edits (a click-only rule still wins if one matches)
// lowIds   *_id keys that are the op's own address or a harmless owner link
// control  keys that address the row and are not field changes
// money    keys that are money here even though their name does not say so
// structure keys that re-section or re-scope money without naming an amount
// Any other *_id key is a RE-LINK (link:<key>) — setting estimate.job_id is the
// 2026-08-09 conversion by another name. Any other key is 'unrecognized'.
function bagSpec(o) {
  return {
    low: new Set(o.low || []),
    lowIds: new Set(o.lowIds || []),
    control: new Set(o.control || []),
    money: new Set(o.money || []),
    structure: new Set(o.structure || []),
  };
}

const BAGS = {
  // client.ops.fields — CLIENT_EDITABLE_FIELDS. parent_client_id re-parents a
  // property (and every rollup under it), so it is left to the link rule.
  client: bagSpec({ low: [
    'name', 'client_type', 'activation_status', 'first_name', 'last_name', 'email', 'phone', 'cell',
    'address', 'city', 'state', 'zip', 'company_name', 'community_name', 'market',
    'property_address', 'property_phone', 'website', 'gate_code', 'additional_pocs',
    'community_manager', 'cm_email', 'cm_phone', 'maintenance_manager', 'mm_email', 'mm_phone',
    'short_name', 'notes',
  ] }),
  // estimate.ops.field_updates — the dispatcher takes ANY blob key not blocked,
  // so this is the list of keys known to be harmless (ESTIMATE_FIELD_KEYS'
  // non-money, non-link names plus the client-snapshot keys a create writes).
  // A key outside it is unrecognized: on a blob that generous, an unknown key
  // is exactly where a money field hides.
  estimate: bagSpec({ low: [
    'name', 'description', 'salesperson', 'market', 'address', 'phone', 'contact_name',
    'contact_email', 'units_label', 'job_name', 'estimate_number', 'bid_due_date', 'expires_on',
    'scope', 'nickName', 'client', 'community', 'propertyAddr', 'billingAddr', 'managerName',
    'managerEmail', 'managerPhone',
  ] }),
  // job.ops.field_updates — same generous blob. `state` is NOT here on purpose:
  // on a job blob it can be the address or a lifecycle, and unsure is a click.
  job: bagSpec({ low: [
    'title', 'name', 'client', 'pm', 'market', 'notes', 'description', 'address',
    'street_address', 'city', 'zip', 'startDate', 'endDate', 'superintendent',
  ] }),
  lead: bagSpec({ low: [
    'title', 'street_address', 'city', 'state', 'zip', 'projected_sale_date', 'source',
    'project_type', 'property_name', 'gate_code', 'market', 'notes',
  ], lowIds: ['salesperson_id'] }),
  calendar_event: bagSpec({ low: [
    'title', 'starts_at', 'ends_at', 'all_day', 'location', 'notes', 'color', 'status',
    'recurrence', 'reminder_minutes', 'entity_type',
  ], lowIds: ['entity_id'] }),
  task: bagSpec({ low: ['title', 'notes', 'kind', 'status', 'priority', 'due_date', 'entity_type'],
    lowIds: ['entity_id', 'assignee_user_id'] }),
  todo: bagSpec({ low: ['title', 'notes', 'kind', 'status', 'priority', 'due_date', 'entity_type'],
    lowIds: ['entity_id'] }),
  reminder: bagSpec({ low: ['title', 'notes', 'remind_at', 'entity_type'], lowIds: ['entity_id'] }),
  service_ticket: bagSpec({ low: [
    'title', 'scope_proposed', 'internal_notes', 'priority', 'requested_by', 'site_contact_name',
    'site_contact_phone', 'street_address', 'city', 'state', 'zip', 'lat', 'lng', 'access_notes',
    'scheduled_for', 'due_date', 'materials',
  ], lowIds: ['job_id', 'lead_id', 'assignee_user_id'] }),
  // A task_adds entry is a BUILDING on a work order's punch list, and from 1.35
  // a building is never assigned to anybody (the work order's own assignee is
  // the whole answer). validateServiceTicketOps refuses `assignee_user_id` here
  // by name and terminally, so it can no longer reach an approval card — and it
  // must not sit in lowIds advertising itself as a harmless owner link if it
  // ever does. Out of the bag it falls to the link rule and reads as a re-link,
  // which is what setting an owner on a building would be.
  ticketTask: bagSpec({ low: ['title', 'notes', 'priority', 'due_date'] }),
  // An assembly's output UNIT is what every takeoff quantity is measured in —
  // SF to LF silently re-prices every estimate that uses the recipe.
  assemblyHeader: bagSpec({ low: ['name', 'code', 'trade', 'category', 'description', 'notes', 'source'],
    money: ['unit'] }),
  // `lines` on a CO / PO / invoice is a WHOLE-ARRAY replace of the money.
  changeOrder: bagSpec({ low: ['title', 'description', 'scope', 'terms', 'notes'], money: ['lines'] }),
  purchaseOrder: bagSpec({ low: ['title', 'description', 'scope', 'notes'], money: ['lines'] }),
  invoice: bagSpec({ low: ['notes', 'billTo', 'terms', 'issue_date', 'due_date'], money: ['lines'] }),
  // job-financials CO_LINE_EDITABLE: description / unit are words; qty, unitCost,
  // unitSell, markup, markupMode and costPending are money (by token).
  coLine: bagSpec({ low: ['description', 'unit'], control: ['line_id', 'line_number', 'op', 'fields', 'id'] }),
  // applyLineEdits assigns ANY key onto an estimate line, so a key that moves
  // the line to another scope or section is structure, and anything else unknown
  // is unrecognized. id / estimateId are skipped by the dispatcher.
  estimateLineEditFlat: bagSpec({ low: ['description', 'unit', 'notes'],
    control: ['line_id', 'op', 'fields', 'subgroup_id', 'id', 'estimateId'],
    structure: ['alternateId', 'alternate_id', 'group_id', 'section', 'section_name', 'btCategory', 'bt_category'] }),
  estimateLineEditNested: bagSpec({ low: ['description', 'unit', 'notes'], control: ['id', 'estimateId'],
    structure: ['alternateId', 'alternate_id', 'group_id', 'section', 'section_name', 'btCategory',
      'bt_category', 'subgroup_id'] }),
  estimateLineAdd: bagSpec({ low: ['description', 'unit', 'section', 'section_name', 'btCategory',
    'bt_category', 'alternate_name', 'group_name'],
  lowIds: ['subgroup_id', 'alternate_id', 'alternateId', 'group_id'], control: ['line_id'] }),
  estimateSection: bagSpec({ low: ['name', 'btCategory'], lowIds: ['alternateId', 'group_id'],
    control: ['op', 'section_id', 'order'] }),
  estimateGroup: bagSpec({ low: ['name', 'scope'], control: ['op', 'group_id'] }),
  // dispatchJob phase_updates reads pct_complete (completion, by shape),
  // materials / labor / sub / equipment (the phase's budget buckets) and
  // buildingId (which building's rollup the phase's money lands in).
  phase: bagSpec({ control: ['phase_id'], money: ['materials', 'labor', 'sub', 'equipment'],
    structure: ['buildingId'] }),
  scheduleBlock: bagSpec({ low: ['startDate', 'start_date', 'days', 'crew', 'includesWeekends',
    'includes_weekends', 'status', 'notes'], lowIds: ['jobId', 'job_id'], control: ['op', 'entry_id'] }),
  reportSection: bagSpec({ low: ['label', 'layout', 'captions', 'text_body'],
    lowIds: ['photo_ids', 'attachment_ids'], control: ['id'] }),
  // reports-routes COVER_PAGE_KEYS. co_amount is left to the money rule.
  cover: bagSpec({ low: ['enabled', 'company_name', 'pm_name', 'date', 'address', 'subtitle', 'crew',
    'weather', 'hours_on_site', 'week_ending', 'project_phase', 'schedule_status', 'stamped_by',
    'license_number', 'signed_date', 'submittal_number', 'spec_section', 'supplier', 'approval_block',
    'walkthrough_date', 'walkthrough_with', 'survey_date', 'surveyed_by', 'building', 'co_number',
    'requested_by'] }),
  photo: bagSpec({ low: ['caption', 'tags'], control: ['attachment_id'] }),
};

// Top-level op keys per entity type — PAYLOAD_OPS_SCHEMAS[type].allowedTopKeys,
// restated (this module requires nothing). test/payload-describe.test.js holds
// the two lists equal, so a key added to the dispatcher fails a test instead of
// quietly becoming a key this file cannot describe. Until then it is
// 'unrecognized' — high — which is the safe direction to drift in.
const ENTITY_TOP_KEYS = Object.freeze({
  client: Object.freeze(['op', 'fields', 'notes', 'structure']),
  estimate: Object.freeze(['op', 'scope', 'field_updates', 'sections', 'groups', 'line_adds',
    'line_edits', 'line_deletes', 'assembly_adds']),
  job: Object.freeze(['field_updates', 'phase_updates', 'change_orders', 'purchase_orders', 'invoices', 'notes']),
  lead: Object.freeze(['op', 'fields', 'notes']),
  schedule: Object.freeze(['blocks']),
  system: Object.freeze(['skill_pack_ops', 'field_tool_ops', 'link_ops']),
  report: Object.freeze(['op', 'template_type', 'parent_type', 'parent_id', 'title', 'cover_page',
    'sections', 'section_adds', 'section_updates', 'section_deletes']),
  calendar_event: Object.freeze(['op', 'fields']),
  task: Object.freeze(['op', 'fields']),
  todo: Object.freeze(['op', 'fields']),
  reminder: Object.freeze(['op', 'fields']),
  assembly: Object.freeze(['op', 'fields', 'items', 'reason', 'source_research_id']),
  attachment: Object.freeze(['photo_updates']),
  deal_memory: Object.freeze(['note_adds', 'note_supersedes']),
  service_ticket: Object.freeze(['op', 'fields', 'task_adds']),
});

const TYPE_LABELS = {
  client: 'Client', estimate: 'Estimate', job: 'Job', lead: 'Lead', schedule: 'Schedule',
  system: 'System', report: 'Report', calendar_event: 'Calendar event', task: 'Task',
  todo: 'To-do', reminder: 'Reminder', assembly: 'Assembly', deal_memory: 'Deal memory',
  attachment: 'Photos', service_ticket: 'Service ticket', project: 'Project',
};

// The kinds a calendar_event / task / todo / reminder may link to.
const LINK_TYPES = new Set(['client', 'job', 'lead', 'project']);

const ID_KEY_TYPES = {
  client: 'client', parent_client: 'client', property: 'client', lead: 'lead', job: 'job',
  estimate: 'estimate', assignee_user: 'user', salesperson: 'user', user: 'user', sub: 'sub',
  pay_application: 'pay_application', co: 'change_order', po: 'purchase_order', invoice: 'invoice',
  phase: 'phase', attachment: 'attachment',
};

// ── formatting ──────────────────────────────────────────────────────────────
function oneLine(s) {
  return String(s).replace(/\s+/g, ' ').trim();
}

function truncate(s, cap) {
  return s.length > cap ? s.slice(0, cap - 1) + '…' : s;
}

function plural(n, one, many) {
  return n + ' ' + (n === 1 ? one : many);
}

function fmtValue(v) {
  if (v === undefined || v === null) return '(blank)';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '(invalid)';
  if (typeof v === 'string') {
    const s = oneLine(v);
    return s ? truncate(s, VALUE_CAP) : '(blank)';
  }
  if (Array.isArray(v)) return plural(v.length, 'item', 'items');
  return '(details)';
}

function humanKey(key, dropId) {
  const c = compactKey(key);
  let t = keyTokens(key);
  if (isCompletionKey(t, c) && isPctKey(t, c)) return '% complete';
  if (dropId && t.length > 1 && (t[t.length - 1] === 'id' || t[t.length - 1] === 'ids')) t = t.slice(0, -1);
  return truncate(t.join(' ') || 'field', KEY_CAP);
}

// A name comes from the caller (the database), never from the payload. A name
// that IS the raw id is no name.
function safeName(state, type, id) {
  if (id == null || id === '' || isRef(id) || !state.nameFor || !type) return null;
  let n;
  try { n = state.nameFor(type, id); } catch (_) { return null; }
  if (typeof n !== 'string') return null;
  n = oneLine(n);
  if (!n || n === String(id).trim()) return null;
  const out = truncate(n, NAME_CAP);
  state.names.push(out);
  return out;
}

function idKeyType(key, bagObj) {
  const base = keyTokens(key).slice(0, -1).join('_');
  if (base === 'entity' && bagObj) {
    const t = normType(bagObj.entity_type);
    return LINK_TYPES.has(t) ? t : null;
  }
  return ID_KEY_TYPES[base] || null;
}

// A raw id is never printed. An id-valued field shows the caller's name for
// the record it points at, or says only that the link changed.
function fieldPhrase(state, key, before, after, mode, bagObj) {
  if (isIdKey(key)) {
    const base = humanKey(key, true);
    if (Array.isArray(after)) return `${base}: ${after.length}`;
    if (after == null || after === '') return mode === 'create' ? `${base} (blank)` : `${base} cleared`;
    if (isRef(after)) return `${base} → (new record)`;
    const name = safeName(state, idKeyType(key, bagObj), after);
    if (mode === 'create') return name ? `${base} ${name}` : `${base} set`;
    return name ? `${base} → ${name}` : `${base} changed`;
  }
  const label = humanKey(key);
  if (mode === 'create') return `${label} ${fmtValue(after)}`;
  if (before !== undefined) return `${label} ${fmtValue(before)} → ${fmtValue(after)}`;
  return `${label} → ${fmtValue(after)}`;
}

// ── before values (the dry-run changeset) ───────────────────────────────────
function beforeRowFor(state, type, id) {
  if (id == null || id === '' || isRef(id)) return undefined;
  for (const row of state.changeset) {
    if (isPlainObject(row) && normType(row.entity_type) === type && row.id != null
        && String(row.id) === String(id)) {
      return isPlainObject(row.before) ? row.before : undefined;
    }
  }
  return undefined;
}

// A found row that lacks the key had no value for it: show (blank), not nothing.
function readBefore(beforeObj, key, blobFirst) {
  if (!isPlainObject(beforeObj)) return undefined;
  const data = isPlainObject(beforeObj.data) ? beforeObj.data : null;
  const has = (o) => o && Object.prototype.hasOwnProperty.call(o, key);
  const order = blobFirst ? [data, beforeObj] : [beforeObj, data];
  for (const o of order) if (has(o)) return o[key];
  return null;
}

function beforeOf(pc, blobFirst) {
  if (pc.mode === 'create' || pc.before === undefined) return undefined;
  return (k) => readBefore(pc.before, k, blobFirst);
}

function blobArray(beforeObj, key) {
  if (!isPlainObject(beforeObj)) return [];
  const data = isPlainObject(beforeObj.data) ? beforeObj.data : beforeObj;
  return Array.isArray(data[key]) ? data[key] : [];
}

function findById(arr, id) {
  if (id == null || id === '') return null;
  return arr.find((x) => isPlainObject(x) && x.id != null && String(x.id) === String(id)) || null;
}

const EST_LINE_KEY_MAP = { unit_cost: 'unitCost', unit_price: 'unitCost', unitPrice: 'unitCost',
  markup_pct: 'markup', markupPct: 'markup', quantity: 'qty' };

function ownOrBlank(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : null;
}

// ── part context ────────────────────────────────────────────────────────────
function newPart(type, entityId, where) {
  return {
    type, entityId, where, mode: 'update', ops: {}, before: undefined, itemAsOps: false,
    phrases: [], reasons: [], fields: [], counts: { added: 0, edited: 0, deleted: 0 },
  };
}

function flag(pc, codes) {
  for (const c of codes) if (!pc.reasons.includes(c)) pc.reasons.push(c);
}

// `codes` make the phrase click-only (it can never be cut by "+N more").
// `covers` are the codes the phrase's WORDS actually tell the user about —
// by default all of them. An aggregate like "cover page replaced" or
// "3 sections updated" covers only its own primary code: a delete or a status
// change walked out of the entries it counts would otherwise be carried by a
// phrase that never names it. Uncovered codes get their own phrase in finishPart.
function say(pc, text, codes, covers) {
  const list = codes ? Array.from(new Set(codes)) : [];
  flag(pc, list);
  pc.phrases.push({ text, codes: list, covers: covers ? Array.from(new Set(covers)) : list });
}

function unrecCodes(detail) {
  return ['unrecognized', 'unrecognized:' + detail];
}

function unrec(pc, detail, text) {
  say(pc, text || 'unrecognized change', unrecCodes(detail));
}

function isMoneyCode(c) {
  return c.indexOf('money:') === 0;
}

function bagKeyCodes(key, value, spec, entityCtx, where) {
  const codes = keyRiskCodes(key, value, entityCtx);
  if (spec.money.has(key) && !codes.some(isMoneyCode)) codes.push('money:' + codeKey(key));
  if (spec.structure.has(key)) codes.push('structure:' + codeKey(key));
  else if (isIdKey(key) && !spec.lowIds.has(key)) codes.push('link:' + codeKey(key));
  if (!codes.length && !spec.low.has(key) && !spec.lowIds.has(key)) {
    codes.push(...unrecCodes(where + '.' + codeKey(key)));
  }
  return codes;
}

function walkBag(state, pc, bagObj, spec, where, opts) {
  const o = opts || {};
  const out = [];
  if (!isPlainObject(bagObj)) {
    unrec(pc, where);
    return out;
  }
  for (const key of Object.keys(bagObj)) {
    if (spec.control.has(key)) continue;
    const after = bagObj[key];
    const codes = bagKeyCodes(key, after, spec, o.entityCtx || pc.type, where);
    const before = o.beforeOf ? o.beforeOf(key) : undefined;
    const field = { key, before, after };
    if (o.label) field.where = o.label;
    pc.fields.push(field);
    out.push({ key, before, after, codes });
  }
  return out;
}

function codesOf(changes) {
  const all = [];
  for (const ch of changes) all.push(...ch.codes);
  return all;
}

function sayFields(state, pc, changes, mode, bagObj, prefix, suffix) {
  for (const ch of changes) {
    // A key this file does not know is shown, but never as if it were ordinary.
    const unknown = ch.codes.includes('unrecognized') ? 'unrecognized ' : '';
    say(pc, (prefix || '') + unknown + fieldPhrase(state, ch.key, ch.before, ch.after, mode, bagObj) + (suffix || ''), ch.codes);
  }
}

function eachEntry(pc, arr, container, fn) {
  if (!Array.isArray(arr)) {
    unrec(pc, container);
    return;
  }
  arr.forEach((entry, i) => {
    if (!isPlainObject(entry)) unrec(pc, `${container}[${i}]`);
    else fn(entry, i);
  });
}

function checkTopKeys(pc) {
  const allowed = ENTITY_TOP_KEYS[pc.type];
  for (const k of Object.keys(pc.ops)) {
    if (allowed.includes(k)) continue;
    if (pc.itemAsOps && k === 'entity_id') continue;
    unrec(pc, 'ops.' + codeKey(k), 'unrecognized ' + humanKey(k));
  }
}

// Mirrors each dispatcher's `ops.op || (target.entity_id ? 'update' : 'create')`
// — truthiness included, because that is what decides which branch runs.
function resolveMode(pc, allowed, dflt) {
  const op = pc.ops.op;
  if (op == null) { pc.mode = dflt; return; }
  if (typeof op === 'string' && allowed.includes(op)) { pc.mode = op; return; }
  pc.mode = 'update';
  unrec(pc, 'ops.op', 'unrecognized operation');
}

// Adds / edits / deletes over an op array, one phrase per kind. perEntry
// returns {kind, codes, walked}: `codes` are what the entry IS (a delete, a
// group add), `walked` are what its keys carried. The phrase covers its own
// codes, and the walked MONEY codes only when coverMoney says the noun already
// means money ("2 lines added" is priced lines; "2 sections added" is not).
function tally(pc, arr, container, nouns, perEntry, coverMoney, prefix) {
  const kinds = { added: [], edited: [], deleted: [] };
  eachEntry(pc, arr, container, (entry, i) => {
    const r = perEntry(entry, i);
    if (r) kinds[r.kind].push(r);
  });
  for (const kind of ['added', 'edited', 'deleted']) {
    const list = kinds[kind];
    if (!list.length) continue;
    pc.counts[kind] += list.length;
    const verb = kind === 'edited' ? 'updated' : kind;
    const own = [].concat(...list.map((r) => r.codes || []));
    const walked = [].concat(...list.map((r) => r.walked || []));
    say(pc, `${prefix || ''}${plural(list.length, nouns[0], nouns[1])} ${verb}`, own.concat(walked),
      own.concat(coverMoney ? walked.filter(isMoneyCode) : []));
  }
}

function sayNotes(pc, notes, container) {
  if (notes == null) return;
  if (!Array.isArray(notes)) { unrec(pc, container); return; }
  if (!notes.length) return;
  pc.counts.added += notes.length;
  // A count, never a body.
  say(pc, `${plural(notes.length, 'note', 'notes')} added`, []);
}

// Per-line edits: one edit is spelled out; several are counted, prices apart
// from words ("2 prices changed, 1 line edited").
function sayLineEdits(state, pc, edits, prefix) {
  if (edits.length === 1 && edits[0].changes.length <= 3) {
    const e = edits[0];
    // "description Stucco patch → Stucco repair on Stucco patch" says the name twice.
    const on = e.lineName && !(e.changes.length === 1 && e.changes[0].key === 'description') ? ` on ${e.lineName}` : '';
    sayFields(state, pc, e.changes, 'update', null, prefix, on);
    if (e.extra.length) say(pc, `${prefix || ''}line moved to another section`, e.extra);
    if (!e.changes.length && !e.extra.length) say(pc, `${prefix || ''}1 line edited`, []);
    return;
  }
  const money = edits.filter((e) => codesOf(e.changes).some(isMoneyCode));
  const other = edits.filter((e) => !money.includes(e));
  const union = (list) => [].concat(...list.map((e) => codesOf(e.changes).concat(e.extra)));
  if (money.length) {
    say(pc, `${prefix || ''}${plural(money.length, 'price', 'prices')} changed`, union(money),
      union(money).filter(isMoneyCode));
  }
  if (other.length) say(pc, `${prefix || ''}${plural(other.length, 'line', 'lines')} edited`, union(other), []);
}

// ── handlers, one per dispatcher ────────────────────────────────────────────
function hEstimate(state, pc) {
  checkTopKeys(pc);
  resolveMode(pc, ['create', 'update'], pc.entityId ? 'update' : 'create');
  const ops = pc.ops;
  if (ops.scope !== undefined) {
    pc.fields.push({ key: 'scope', before: undefined, after: ops.scope });
    say(pc, fieldPhrase(state, 'scope', undefined, ops.scope, pc.mode), []);
  }
  if (ops.field_updates != null) {
    const changes = walkBag(state, pc, ops.field_updates, BAGS.estimate, 'field_updates',
      { beforeOf: beforeOf(pc, true) });
    sayFields(state, pc, changes, pc.mode, ops.field_updates);
  }
  if (ops.sections != null) {
    tally(pc, ops.sections, 'sections', ['section', 'sections'], (s, i) => {
      if (s.op === 'delete') return { kind: 'deleted', codes: ['delete:sections'] };
      if (s.op === 'add' || s.op === 'update') {
        return { kind: s.op === 'add' ? 'added' : 'edited',
          walked: codesOf(walkBag(state, pc, s, BAGS.estimateSection, `sections[${i}]`)) };
      }
      // reorder writes `position` on headers; section membership is ARRAY
      // position, and nothing here can prove the two never disagree.
      if (s.op === 'reorder') return { kind: 'edited', codes: ['structure:sections.reorder'] };
      unrec(pc, `sections[${i}].op`);
      return null;
    });
  }
  if (ops.groups != null) {
    tally(pc, ops.groups, 'groups', ['scope', 'scopes'], (g, i) => {
      if (g.op === 'delete') return { kind: 'deleted', codes: ['delete:groups'] };
      // A group ADD on an estimate with no alternates flips both totals engines
      // from "sum every line" to "sum lines in an included group" — the first
      // group can zero the proposal (see applyEstimateScopeText).
      if (g.op === 'add') {
        return { kind: 'added', codes: ['structure:groups.add'],
          walked: codesOf(walkBag(state, pc, g, BAGS.estimateGroup, `groups[${i}]`)) };
      }
      if (g.op === 'update') {
        return { kind: 'edited', walked: codesOf(walkBag(state, pc, g, BAGS.estimateGroup, `groups[${i}]`)) };
      }
      unrec(pc, `groups[${i}].op`);
      return null;
    });
  }
  if (ops.line_adds != null) {
    tally(pc, ops.line_adds, 'line_adds', ['line', 'lines'], (a, i) => (
      { kind: 'added', walked: codesOf(walkBag(state, pc, a, BAGS.estimateLineAdd, `line_adds[${i}]`)) }), true);
  }
  if (ops.assembly_adds != null) sayAssemblyAdds(pc, ops.assembly_adds, 'assembly_adds', '');
  if (ops.line_edits != null) {
    const lines = blobArray(pc.before, 'lines');
    const edits = [];
    eachEntry(pc, ops.line_edits, 'line_edits', (e, i) => {
      const nested = isPlainObject(e.fields);
      const line = pc.mode === 'create' ? null : findById(lines, e.line_id);
      const changes = walkBag(state, pc, nested ? e.fields : e,
        nested ? BAGS.estimateLineEditNested : BAGS.estimateLineEditFlat, `line_edits[${i}]`,
        { beforeOf: line ? (k) => ownOrBlank(line, EST_LINE_KEY_MAP[k] || k) : undefined });
      // subgroup_id on an edit is a MOVE: the dispatcher re-splices the row,
      // and a section carries its own markup.
      const extra = (e.subgroup_id != null && e.subgroup_id !== '') ? ['structure:subgroup_id'] : [];
      const lineName = line && typeof line.description === 'string' && oneLine(line.description)
        ? truncate(oneLine(line.description), NAME_CAP) : null;
      edits.push({ changes, extra, lineName });
    });
    pc.counts.edited += edits.length;
    if (edits.length) sayLineEdits(state, pc, edits, '');
  }
  if (ops.line_deletes != null) {
    if (!Array.isArray(ops.line_deletes)) unrec(pc, 'line_deletes');
    else if (ops.line_deletes.length) {
      pc.counts.deleted += ops.line_deletes.length;
      say(pc, `${plural(ops.line_deletes.length, 'line', 'lines')} deleted`, ['delete:line_deletes']);
    }
  }
}

function sayAssemblyAdds(pc, arr, container, prefix) {
  if (!Array.isArray(arr)) { unrec(pc, container); return; }
  if (!arr.length) return;
  arr.forEach((e, i) => { if (!isPlainObject(e)) unrec(pc, `${container}[${i}]`); });
  pc.counts.added += arr.length;
  // A costed recipe is priced lines, whatever its params look like.
  say(pc, `${prefix}${arr.length} ${arr.length === 1 ? 'assembly' : 'assemblies'} added`, ['money:assembly_adds']);
}

const RECORDS = [
  { container: 'change_orders', idKey: 'co_id', type: 'change_order', noun: 'change order',
    bag: BAGS.changeOrder, lineOps: true, assemblyAdds: true },
  { container: 'purchase_orders', idKey: 'po_id', type: 'purchase_order', noun: 'purchase order',
    bag: BAGS.purchaseOrder },
  { container: 'invoices', idKey: 'invoice_id', type: 'invoice', noun: 'invoice', bag: BAGS.invoice },
];

function recordOps(state, pc, arr, R) {
  if (arr == null) return;
  eachEntry(pc, arr, R.container, (r, i) => {
    const where = `${R.container}[${i}]`;
    const allowed = ['op', R.idKey, 'fields']
      .concat(R.lineOps ? ['line_edits', 'line_adds', 'line_deletes'] : [])
      .concat(R.assemblyAdds ? ['assembly_adds'] : []);
    for (const k of Object.keys(r)) {
      if (!allowed.includes(k)) unrec(pc, `${where}.${codeKey(k)}`, `unrecognized ${R.noun} ${humanKey(k)}`);
    }
    const name = r.op === 'create' ? null : safeName(state, R.type, r[R.idKey]);
    const label = name ? `${R.noun} ${name}` : R.noun;
    if (r.op === 'create') {
      pc.counts.added++;
      // Creating a change order, purchase order or invoice creates money —
      // whatever its fields say.
      const codes = ['money:' + R.container + '.create'];
      if (R.assemblyAdds && present(r.assembly_adds)) codes.push('money:assembly_adds');
      const walked = r.fields != null
        ? codesOf(walkBag(state, pc, r.fields, R.bag, where + '.fields', { entityCtx: R.type, label })) : [];
      say(pc, `${R.noun} created`, codes.concat(walked), codes.concat(walked.filter(isMoneyCode)));
    } else if (r.op === 'update') {
      pc.counts.edited++;
      const before = pc.phrases.length;
      if (r.fields != null) {
        const changes = walkBag(state, pc, r.fields, R.bag, where + '.fields', { entityCtx: R.type, label });
        sayFields(state, pc, changes, 'update', r.fields, label + ': ');
      }
      if (R.lineOps) coLineOps(state, pc, r, where, label);
      if (R.assemblyAdds && r.assembly_adds != null) sayAssemblyAdds(pc, r.assembly_adds, where + '.assembly_adds', label + ': ');
      if (pc.phrases.length === before) say(pc, `${label} updated`, []);
    } else if (r.op === 'delete') {
      pc.counts.deleted++;
      say(pc, `${label} deleted`, ['delete:' + R.container]);
    } else {
      unrec(pc, `${where}.op`, `unrecognized ${R.noun} operation`);
    }
  });
}

function coLineOps(state, pc, r, where, label) {
  const prefix = label + ': ';
  if (r.line_edits != null) {
    const edits = [];
    eachEntry(pc, r.line_edits, where + '.line_edits', (e, i) => {
      const bagObj = isPlainObject(e.fields) ? e.fields : e;
      const changes = walkBag(state, pc, bagObj, BAGS.coLine, `${where}.line_edits[${i}]`,
        { entityCtx: 'change_order', label });
      edits.push({ changes, extra: [], lineName: null });
    });
    pc.counts.edited += edits.length;
    if (edits.length) sayLineEdits(state, pc, edits, prefix);
  }
  if (r.line_adds != null) {
    tally(pc, r.line_adds, where + '.line_adds', ['line', 'lines'], (a, i) => {
      const bagObj = isPlainObject(a.fields) ? a.fields : a;
      return { kind: 'added', walked: codesOf(walkBag(state, pc, bagObj, BAGS.coLine,
        `${where}.line_adds[${i}]`, { entityCtx: 'change_order', label })) };
    }, true, prefix);
  }
  if (r.line_deletes != null) {
    if (!Array.isArray(r.line_deletes)) unrec(pc, where + '.line_deletes');
    else if (r.line_deletes.length) {
      pc.counts.deleted += r.line_deletes.length;
      say(pc, `${prefix}${plural(r.line_deletes.length, 'line', 'lines')} deleted`, ['delete:line_deletes']);
    }
  }
}

function hJob(state, pc) {
  // node_values / wire_updates / graph / qb_assignments are RETIRED and land in
  // checkTopKeys as unrecognized — the dispatcher refuses them by name.
  checkTopKeys(pc);
  pc.mode = 'update';
  const ops = pc.ops;
  if (ops.field_updates != null) {
    const changes = walkBag(state, pc, ops.field_updates, BAGS.job, 'field_updates', { beforeOf: beforeOf(pc, true) });
    sayFields(state, pc, changes, 'update', ops.field_updates);
  }
  if (ops.phase_updates != null) {
    const phases = blobArray(pc.before, 'phases');
    const list = [];
    eachEntry(pc, ops.phase_updates, 'phase_updates', (pu, i) => {
      const phase = findById(phases, pu.phase_id);
      const dbName = phase && (typeof phase.name === 'string' || typeof phase.title === 'string')
        ? oneLine(phase.name || phase.title) : '';
      const pname = dbName ? truncate(dbName, NAME_CAP) : safeName(state, 'phase', pu.phase_id);
      const changes = walkBag(state, pc, pu, BAGS.phase, `phase_updates[${i}]`, {
        beforeOf: phase ? (k) => ownOrBlank(phase, k === 'pct_complete' ? 'pctComplete' : k) : undefined,
        label: pname ? `phase ${pname}` : 'phase',
      });
      list.push({ changes, pname });
    });
    pc.counts.edited += list.length;
    const total = list.reduce((n, p) => n + p.changes.length, 0);
    if (total <= 3) {
      for (const p of list) sayFields(state, pc, p.changes, 'update', null, '', p.pname ? ` on ${p.pname}` : ' on a phase');
    } else {
      say(pc, `${plural(list.length, 'phase', 'phases')} updated`, [].concat(...list.map((p) => codesOf(p.changes))), []);
    }
  }
  for (const R of RECORDS) recordOps(state, pc, ops[R.container], R);
  sayNotes(pc, ops.notes, 'notes');
}

function hFieldsEntity(bagName) {
  return function hFields(state, pc) {
    checkTopKeys(pc);
    resolveMode(pc, ['create', 'update'], pc.entityId ? 'update' : 'create');
    const ops = pc.ops;
    if (ops.fields != null) {
      const changes = walkBag(state, pc, ops.fields, BAGS[bagName], 'fields', { beforeOf: beforeOf(pc, false) });
      sayFields(state, pc, changes, pc.mode, ops.fields);
    }
    sayNotes(pc, ops.notes, 'notes');
    // client.ops.structure (merge / split / delete / reparent) is declared in
    // the schema and executed by NOTHING — a declared-but-unread key is not a
    // key this file can call safe.
    if (ops.structure != null) unrec(pc, 'ops.structure', 'unrecognized client structure change');
  };
}

function hSchedule(state, pc) {
  checkTopKeys(pc);
  pc.mode = 'update';
  if (!Array.isArray(pc.ops.blocks) || !pc.ops.blocks.length) { unrec(pc, 'blocks'); return; }
  tally(pc, pc.ops.blocks, 'blocks', ['schedule entry', 'schedule entries'], (b, i) => {
    if (b.op === 'delete') return { kind: 'deleted', codes: ['delete:blocks'] };
    if (b.op === 'create' || b.op === 'update') {
      return { kind: b.op === 'create' ? 'added' : 'edited',
        walked: codesOf(walkBag(state, pc, b, BAGS.scheduleBlock, `blocks[${i}]`)) };
    }
    unrec(pc, `blocks[${i}].op`);
    return null;
  });
}

function hSystem(state, pc) {
  checkTopKeys(pc);
  pc.mode = 'update';
  // Skill packs, field tools, cross-entity links: platform writes, always a click.
  say(pc, 'system change', ['system']);
}

function hReport(state, pc) {
  checkTopKeys(pc);
  resolveMode(pc, ['create', 'update'], pc.entityId ? 'update' : 'create');
  const ops = pc.ops;
  for (const k of ['template_type', 'parent_type', 'title']) {
    if (ops[k] === undefined) continue;
    pc.fields.push({ key: k, before: undefined, after: ops[k] });
    say(pc, fieldPhrase(state, k, undefined, ops[k], pc.mode), []);
  }
  if (ops.parent_id != null) {
    pc.fields.push({ key: 'parent_id', before: undefined, after: ops.parent_id });
    const name = safeName(state, 'project', ops.parent_id);
    say(pc, name ? `project ${name}` : 'project set', []);
  }
  if (ops.cover_page != null) {
    say(pc, 'cover page ' + (pc.mode === 'create' ? 'set' : 'replaced'),
      codesOf(walkBag(state, pc, ops.cover_page, BAGS.cover, 'cover_page')), []);
  }
  if (ops.sections != null) {
    const codes = [];
    eachEntry(pc, ops.sections, 'sections', (s, i) => codes.push(...codesOf(walkBag(state, pc, s, BAGS.reportSection, `sections[${i}]`))));
    const n = Array.isArray(ops.sections) ? ops.sections.length : 0;
    if (pc.mode === 'create') {
      pc.counts.added += n;
      say(pc, `${plural(n, 'section', 'sections')}`, codes, []);
    } else {
      // A full `sections` array on an update REPLACES every section — the ones
      // it omits are gone.
      say(pc, `all sections replaced (${n})`, ['delete:sections'].concat(codes), ['delete:sections']);
    }
  }
  if (ops.section_adds != null) {
    tally(pc, ops.section_adds, 'section_adds', ['section', 'sections'], (s, i) => (
      { kind: 'added', walked: codesOf(walkBag(state, pc, s, BAGS.reportSection, `section_adds[${i}]`)) }));
  }
  if (ops.section_updates != null) {
    tally(pc, ops.section_updates, 'section_updates', ['section', 'sections'], (s, i) => (
      { kind: 'edited', walked: codesOf(walkBag(state, pc, s, BAGS.reportSection, `section_updates[${i}]`)) }));
  }
  if (ops.section_deletes != null) {
    if (!Array.isArray(ops.section_deletes)) unrec(pc, 'section_deletes');
    else if (ops.section_deletes.length) {
      pc.counts.deleted += ops.section_deletes.length;
      say(pc, `${plural(ops.section_deletes.length, 'section', 'sections')} deleted`, ['delete:section_deletes']);
    }
  }
}

// calendar_event / task / todo / reminder — create-only, one field bag, an
// optional link to a client / job / lead / project.
function hPersonal(bagName) {
  return function hItem(state, pc) {
    checkTopKeys(pc);
    resolveMode(pc, ['create'], 'create');
    const f = pc.ops.fields;
    if (!isPlainObject(f)) { unrec(pc, 'fields'); return; }
    const changes = walkBag(state, pc, f, BAGS[bagName], 'fields');
    const isLink = (ch) => ch.key === 'entity_type' || ch.key === 'entity_id';
    sayFields(state, pc, changes.filter((ch) => !isLink(ch)), 'create', f);
    const link = changes.filter(isLink);
    if (link.length) {
      const t = normType(f.entity_type);
      const known = LINK_TYPES.has(t);
      const name = known ? safeName(state, t, f.entity_id) : null;
      say(pc, `linked to ${known ? TYPE_LABELS[t].toLowerCase() : 'a record'}${name ? ' ' + name : ''}`, codesOf(link));
    }
  };
}

function hAssembly(state, pc) {
  checkTopKeys(pc);
  resolveMode(pc, ['create', 'update', 'delete'], pc.entityId ? 'update' : 'create');
  const ops = pc.ops;
  if (pc.mode === 'delete') {
    pc.counts.deleted++;
    say(pc, 'assembly deleted', ['delete:op']);
  }
  if (ops.fields != null) {
    const changes = walkBag(state, pc, ops.fields, BAGS.assemblyHeader, 'fields');
    sayFields(state, pc, changes, pc.mode === 'create' ? 'create' : 'update', ops.fields);
  }
  if (ops.items != null) {
    if (!Array.isArray(ops.items)) unrec(pc, 'items');
    else {
      // items is a FULL replace of the recipe rows — including `items: []`.
      const n = ops.items.length;
      say(pc, pc.mode === 'create' ? `recipe of ${plural(n, 'item', 'items')}` : `recipe replaced (${plural(n, 'item', 'items')})`,
        ['money:items']);
    }
  }
  // `reason` is model prose (it lands in assembly_tuning_log) — recognised,
  // never read. source_research_id is provenance, not a field change.
}

function hDealMemory(state, pc) {
  checkTopKeys(pc);
  pc.mode = 'update';
  const ops = pc.ops;
  if (ops.note_adds != null) {
    if (!Array.isArray(ops.note_adds)) unrec(pc, 'note_adds');
    else if (ops.note_adds.length) {
      ops.note_adds.forEach((n, i) => {
        if (typeof n === 'string') return;
        if (!isPlainObject(n) || Object.keys(n).some((k) => k !== 'text')) unrec(pc, `note_adds[${i}]`);
      });
      pc.counts.added += ops.note_adds.length;
      say(pc, `${plural(ops.note_adds.length, 'memory note', 'memory notes')} added`, []);
    }
  }
  if (ops.note_supersedes != null) {
    if (!Array.isArray(ops.note_supersedes)) unrec(pc, 'note_supersedes');
    else if (ops.note_supersedes.length) {
      ops.note_supersedes.forEach((s, i) => {
        if (!isPlainObject(s) || Object.keys(s).some((k) => k !== 'id')) unrec(pc, `note_supersedes[${i}]`);
      });
      pc.counts.edited += ops.note_supersedes.length;
      say(pc, `${plural(ops.note_supersedes.length, 'memory note', 'memory notes')} retired`, []);
    }
  }
}

function hAttachment(state, pc) {
  checkTopKeys(pc);
  pc.mode = 'update';
  const list = [];
  eachEntry(pc, pc.ops.photo_updates, 'photo_updates', (u, i) => {
    const before = beforeRowFor(state, 'attachment', u.attachment_id);
    list.push(walkBag(state, pc, u, BAGS.photo, `photo_updates[${i}]`,
      { beforeOf: before ? (k) => readBefore(before, k, false) : undefined }));
  });
  pc.counts.edited += list.length;
  if (list.length === 1) {
    sayFields(state, pc, list[0], 'update', null);
    return;
  }
  const caps = list.filter((ch) => ch.some((c) => c.key === 'caption'));
  const tags = list.filter((ch) => ch.some((c) => c.key === 'tags'));
  const rest = [].concat(...list.map((ch) => ch.filter((c) => c.key !== 'caption' && c.key !== 'tags')));
  if (caps.length) say(pc, `${plural(caps.length, 'photo description', 'photo descriptions')} updated`, [].concat(...caps.map(codesOf)), []);
  if (tags.length) say(pc, `${plural(tags.length, 'photo tag set', 'photo tag sets')} updated`, [].concat(...tags.map(codesOf)), []);
  if (rest.length) sayFields(state, pc, rest, 'update', null);
}

function hServiceTicket(state, pc) {
  checkTopKeys(pc);
  // dispatchServiceTicket: `ops.op == null ? 'create' : ops.op`.
  resolveMode(pc, ['create', 'update'], 'create');
  const ops = pc.ops;
  if (ops.fields != null) {
    const changes = walkBag(state, pc, ops.fields, BAGS.service_ticket, 'fields', { beforeOf: beforeOf(pc, false) });
    sayFields(state, pc, changes, pc.mode, ops.fields);
  }
  if (ops.task_adds != null) {
    tally(pc, ops.task_adds, 'task_adds', ['task', 'tasks'], (t, i) => (
      { kind: 'added', walked: codesOf(walkBag(state, pc, t, BAGS.ticketTask, `task_adds[${i}]`)) }));
  }
}

const HANDLERS = {
  client: hFieldsEntity('client'),
  estimate: hEstimate,
  job: hJob,
  lead: hFieldsEntity('lead'),
  schedule: hSchedule,
  system: hSystem,
  report: hReport,
  calendar_event: hPersonal('calendar_event'),
  task: hPersonal('task'),
  todo: hPersonal('todo'),
  reminder: hPersonal('reminder'),
  assembly: hAssembly,
  deal_memory: hDealMemory,
  attachment: hAttachment,
  service_ticket: hServiceTicket,
};

// ── the key sweep ───────────────────────────────────────────────────────────
function contextType(type, path) {
  for (let i = path.length - 1; i >= 0; i--) {
    if (CONTAINER_TYPES[path[i]]) return CONTAINER_TYPES[path[i]];
  }
  return type;
}

function sweep(pc, node, path, container, depth) {
  if (depth > MAX_SWEEP_DEPTH) {
    flag(pc, unrecCodes('too_deep'));
    return;
  }
  if (Array.isArray(node)) {
    for (const v of node) sweep(pc, v, path, container, depth + 1);
    return;
  }
  if (!isPlainObject(node)) return;
  for (const key of Object.keys(node)) {
    const v = node[key];
    flag(pc, keyRiskCodes(key, v, contextType(pc.type, path)));
    if (OP_KEYS.has(key) && typeof v === 'string' && DELETE_OP_VALUES.has(v.trim().toLowerCase())) {
      flag(pc, ['delete:' + (container || 'op')]);
    }
    if (v && typeof v === 'object') sweep(pc, v, path.concat(key), Array.isArray(v) ? key : container, depth + 1);
  }
}

// ── targets ─────────────────────────────────────────────────────────────────
const TARGET_KEYS = new Set(['entity_type', 'entity_id', 'ops', 'condition', 'bulk']);
const MOVE_KEYS = new Set(['op', 'source', 'dest']);
const BULK_ITEM_KEYS = new Set(['entity_id', 'ops']);

function concretePart(state, t, where, itemAsOps) {
  const type = normType(t.entity_type);
  const pc = newPart(type, t.entity_id == null ? null : t.entity_id, where);
  state.parts.push(pc);
  pc.itemAsOps = itemAsOps;
  const handler = HANDLERS[type];
  if (!handler) {
    say(pc, 'unrecognized change', unrecCodes(where + '.entity_type'));
    sweep(pc, t.ops, [], undefined, 0);
    return pc;
  }
  if (t.ops != null && !isPlainObject(t.ops)) {
    unrec(pc, where + '.ops');
    return pc;
  }
  pc.ops = isPlainObject(t.ops) ? t.ops : {};
  pc.before = beforeRowFor(state, type, pc.entityId);
  handler(state, pc);
  sweep(pc, pc.ops, [], undefined, 0);
  return pc;
}

function walkTarget(state, t, where, depth) {
  if (depth > MAX_TARGET_DEPTH || !isPlainObject(t)) {
    const pc = newPart('', null, where);
    state.parts.push(pc);
    unrec(pc, depth > MAX_TARGET_DEPTH ? where + ':too_deep' : where);
    return [pc];
  }
  const tcodes = [];
  const isMove = t.op === 'move';
  const allowed = isMove ? MOVE_KEYS : TARGET_KEYS;
  for (const k of Object.keys(t)) {
    if (!allowed.has(k) && !FREE_TEXT_KEYS.has(k)) tcodes.push(...unrecCodes(`${where}.${codeKey(k)}`));
  }
  // A target-level `op` other than 'move' executes nothing — runTarget ignores
  // it — but a model that wrote op:'delete' there meant a delete.
  if (!isMove && typeof t.op === 'string' && DELETE_OP_VALUES.has(t.op.trim().toLowerCase())) {
    tcodes.push('delete:target.op');
  }
  const created = [];
  if (isMove) {
    for (const side of ['source', 'dest']) {
      const s = t[side];
      if (!isPlainObject(s)) { tcodes.push(...unrecCodes(`${where}.${side}`)); continue; }
      // dispatchConcrete runs a side's ops and nothing else; a side shaped as a
      // move, bulk or condition is a form that silently does not run. Walk it
      // anyway — every op location it holds is still classified.
      if (s.op === 'move' || s.bulk != null || s.condition != null) {
        tcodes.push(...unrecCodes(`${where}.${side}.form`));
      }
      created.push(...walkTarget(state, s, `${where}.${side}`, depth + 1));
    }
  } else if (t.bulk != null) {
    // runTarget runs bulk and returns: a sibling `ops` or `condition` is dropped
    // without a word. Two addresses for one write — refuse to call it safe.
    if (t.ops != null) tcodes.push(...unrecCodes(`${where}.ops_beside_bulk`));
    if (t.condition != null) tcodes.push(...unrecCodes(`${where}.condition_beside_bulk`));
    const items = isPlainObject(t.bulk) ? t.bulk.items : null;
    if (isPlainObject(t.bulk)) {
      for (const k of Object.keys(t.bulk)) if (k !== 'items') tcodes.push(...unrecCodes(`${where}.bulk.${codeKey(k)}`));
    }
    if (!Array.isArray(items) || !items.length) {
      tcodes.push(...unrecCodes(`${where}.bulk`));
    } else {
      items.forEach((item, i) => {
        const iw = `${where}.bulk.items[${i}]`;
        if (!isPlainObject(item)) {
          const pc = newPart(normType(t.entity_type), null, iw);
          state.parts.push(pc);
          unrec(pc, iw);
          created.push(pc);
          return;
        }
        // runTarget: `ops: (item && (item.ops || item)) || {}` — an item with no
        // ops IS its ops object. Skipping that spelling is how a bulk item hides.
        const asOps = !item.ops;
        const pc = concretePart(state,
          { entity_type: t.entity_type, entity_id: item.entity_id, ops: asOps ? item : item.ops }, iw, asOps);
        if (!asOps) {
          for (const k of Object.keys(item)) {
            if (!BULK_ITEM_KEYS.has(k) && !FREE_TEXT_KEYS.has(k)) unrec(pc, `${iw}.${codeKey(k)}`);
          }
        }
        created.push(pc);
      });
    }
  } else {
    if (t.condition != null && !CONDITIONS.has(t.condition)) tcodes.push(...unrecCodes(`${where}.condition`));
    created.push(concretePart(state, t, where, false));
  }
  if (tcodes.length) {
    let host = created[0];
    if (!host) {
      host = newPart(normType(t.entity_type), null, where);
      state.parts.push(host);
      created.push(host);
    }
    // The shape phrase names only the shape; a delete spelled at target level
    // gets its own words from finishPart.
    say(host, 'unrecognized target shape', tcodes, tcodes.filter((c) => c.indexOf('unrecognized') === 0));
  }
  return created;
}

// ── finishing ───────────────────────────────────────────────────────────────
function reasonPhrase(code) {
  const i = code.indexOf(':');
  const fam = i < 0 ? code : code.slice(0, i);
  const rest = i < 0 ? '' : code.slice(i + 1);
  const what = rest ? humanKey(rest.replace(/\[\d+\]/g, '').split('.').pop()) : '';
  switch (fam) {
    case 'delete': return `delete (${what})`;
    case 'money': return `money field ${what}`;
    case 'completion': return '% complete change';
    case 'status_change': return 'status change';
    case 'send': return `outbound send (${what})`;
    case 'link': return `re-link ${what}`;
    case 'structure': return `structure change (${what})`;
    case 'system': return 'system change';
    default: return 'unrecognized change';
  }
}

// Every reason a part carries must be visible in the line — a code the sweep
// found where the structured walk wrote no phrase gets a phrase of its own.
function finishPart(pc) {
  const covered = new Set();
  for (const p of pc.phrases) for (const c of p.covers) covered.add(c);
  // Once the line already shows this part moving money ("invoice created",
  // "lines → 1 item"), the qty and unitPrice keys the sweep found inside it add
  // words, not information. A part whose phrases show no money still gets every
  // money key spelled out — that is the case the phrase exists for.
  const showsMoney = [...covered].some(isMoneyCode);
  for (const code of pc.reasons.slice()) {
    if (covered.has(code) || code === 'unrecognized' || (showsMoney && isMoneyCode(code))) continue;
    say(pc, reasonPhrase(code), code.indexOf('unrecognized:') === 0 ? ['unrecognized', code] : [code]);
    covered.add(code);
  }
  if (pc.reasons.includes('unrecognized') && !pc.phrases.some((p) => p.covers.includes('unrecognized'))) {
    say(pc, 'unrecognized change', ['unrecognized']);
  }
  if (!pc.phrases.length) say(pc, 'no change', []);
}

function partLabel(state, pc) {
  const typeLabel = HANDLERS[pc.type] ? TYPE_LABELS[pc.type] : null;
  // An unknown entity_type is never echoed: it is model text, and it could say
  // "Convert estimate to job" as easily as a title could.
  if (!typeLabel) return 'Unrecognized change';
  if (pc.mode === 'create') return 'New ' + typeLabel.toLowerCase();
  const name = safeName(state, pc.type, pc.entityId);
  return name ? `${typeLabel} · ${name}` : typeLabel;
}

function renderLine(state) {
  if (!state.parts.length) return 'Unrecognized change';
  // Click-only parts lead; within a part, click-only phrases lead.
  const risky = state.parts.filter((pc) => pc.reasons.length);
  const ordered = risky.concat(state.parts.filter((pc) => !pc.reasons.length));
  const labels = new Map(ordered.map((pc) => [pc, partLabel(state, pc)]));
  const slots = [];
  for (const pc of ordered) {
    for (const p of pc.phrases) if (p.codes.length) slots.push({ pc, text: p.text, must: true });
    for (const p of pc.phrases) if (!p.codes.length) slots.push({ pc, text: p.text, must: false });
  }
  const chosen = new Set(slots.filter((s) => s.must));
  const render = (dropped) => {
    const segs = [];
    for (const pc of ordered) {
      const texts = slots.filter((s) => s.pc === pc && chosen.has(s)).map((s) => s.text);
      if (texts.length) segs.push(`${labels.get(pc)} — ${texts.join(', ')}`);
    }
    return segs.join('; ') + (dropped ? ` +${dropped} more` : '');
  };
  let dropped = 0;
  let full = false;
  for (const s of slots) {
    if (s.must) continue;
    if (!full) {
      chosen.add(s);
      // room is kept for the " +N more" suffix the next drop would add
      if (render(0).length > LINE_BUDGET - 10) { chosen.delete(s); full = true; }
    }
    if (!chosen.has(s)) dropped++;
  }
  return render(dropped);
}

function collectIds(node, out, depth) {
  if (depth > MAX_SWEEP_DEPTH || node == null || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const v of node) collectIds(v, out, depth + 1); return; }
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (isIdKey(k)) {
      for (const x of (Array.isArray(v) ? v : [v])) {
        if (typeof x === 'string' || typeof x === 'number') out.add(String(x).trim());
      }
    }
    if (v && typeof v === 'object') collectIds(v, out, depth + 1);
  }
}

// The belt under "raw ids are never formatted": anything id-shaped from the
// targets or the changeset that still reached the line — pasted into a notes
// value, say — is cut out. A short all-digit id (user 7, assembly 42) is left
// alone because it is indistinguishable from a quantity; ids the caller's own
// nameFor() chose to print (a job number in "2024-017 Harbor Point") stay.
function scrubIds(state, line, targets) {
  const ids = new Set();
  collectIds(targets, ids, 0);
  collectIds(state.changeset, ids, 0);
  const eligible = [...ids]
    .filter((s) => (s.length >= 4 && /\D/.test(s)) || /^\d{6,}$/.test(s))
    .filter((s) => !state.names.some((n) => n.includes(s)))
    .sort((a, b) => b.length - a.length);
  let out = line;
  for (const s of eligible) if (out.includes(s)) out = out.split(s).join('…');
  return out;
}

function parseMaybeJson(v) {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch (_) { return undefined; }
}

function analyze(targets, draftChangeset, opts) {
  const cs = parseMaybeJson(draftChangeset);
  const state = {
    parts: [],
    globalReasons: [],
    changeset: Array.isArray(cs) ? cs : [],
    nameFor: opts && typeof opts.nameFor === 'function' ? opts.nameFor : null,
    names: [],
  };
  const list = parseMaybeJson(targets);
  if (!Array.isArray(list) || !list.length) {
    state.globalReasons.push(...unrecCodes('targets'));
  } else {
    list.forEach((t, i) => walkTarget(state, t, `targets[${i}]`, 0));
  }
  for (const pc of state.parts) finishPart(pc);
  const reasons = [];
  for (const c of state.globalReasons.concat(...state.parts.map((pc) => pc.reasons))) {
    if (!reasons.includes(c)) reasons.push(c);
  }
  return { state, list, reasons };
}

/**
 * describePayload(targets, draftChangeset, opts) -> { line, risk, clickOnly, reasons, parts }
 *
 * targets         the payload's targets array (or its JSON string, as stored)
 * draftChangeset  dry-run apply_changeset rows [{entity_type, id, before, after}] — BEFORE values only
 * opts.nameFor    (entity_type, entity_id) -> string|null, resolved by the caller from the DB
 */
function describePayload(targets, draftChangeset, opts) {
  const { state, list, reasons } = analyze(targets, draftChangeset, opts);
  const risk = reasons.length ? 'high' : 'low';
  const line = scrubIds(state, renderLine(state), list);
  return {
    line,
    risk,
    clickOnly: risk === 'high',
    reasons,
    parts: state.parts.map((pc) => ({
      entity_type: pc.type || null,
      entity_id: pc.entityId,
      fields: pc.fields,
      counts: Object.assign({}, pc.counts),
      reasons: pc.reasons.slice(),
    })),
  };
}

/**
 * classifyRisk(targets) -> { risk, reasons }
 * The verdict alone, for isHighRiskPayload to delegate to.
 */
function classifyRisk(targets) {
  const { reasons } = analyze(targets, null, null);
  return { risk: reasons.length ? 'high' : 'low', reasons };
}

module.exports = {
  describePayload,
  classifyRisk,
  ENTITY_TOP_KEYS,
  LINE_BUDGET,
  VALUE_CAP,
};
