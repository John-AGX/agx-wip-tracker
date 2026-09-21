// ============================================================
// Project 86 — what a lead becomes
// ------------------------------------------------------------
// A lead that is won turns into ONE of three records, and until now only one
// of them existed as a door: POST /api/jobs/convert. John, 2026-09-19:
//
//   "work orders are mainly for urgent issues, a go and do this, it's approved
//    type of call... service tickets are for our smaller service jobs 10k and
//    below, these would already have a contract price and estimate to work from
//    as far as setting up a scope when the job converts. we need to make the
//    convert to screen to WO, Service ticket or JOB more robust as well."
//
// So the screen asks one question and the answer decides which record is born:
//
//   Job            jobs row          S####/RV####  from the org registry
//   Service ticket bill_as contract  ST-####       priced from the estimate
//   Work order     bill_as t&m       WO-####       no price; billed after
//
// This file holds the parts of that decision with no database in them — what
// carries over from the lead, and how a scope is read off an estimate — so
// they can be read and tested without a route. The route
// (routes/service-ticket-routes.js POST /convert) owns the transaction, the
// refusals and the numbering.
'use strict';

// The two words a convert may name. Unlike a plain create, where saying
// nothing keeps the old shape, a CONVERT must say what it is making: the whole
// point of the screen is that somebody chose.
const CONVERT_KINDS = Object.freeze(['work_order', 'service_ticket']);
const KIND_REQUIRED =
  'Say what this lead is becoming: a work order (billed after the work) or a service ticket (a contract price).';
const ALREADY_A_JOB = 'This lead already became a job.';
const ALREADY_A_TICKET = 'This lead already became a ticket.';
const ESTIMATE_SOLD_TO_JOB =
  'That estimate has already been sold to a job. Duplicate it and attach the copy instead.';
const ESTIMATE_SOLD_TO_TICKET =
  'That estimate has already been sold to a ticket. Duplicate it and attach the copy instead.';

// John's line, 2026-09-19: service tickets are "our smaller service jobs 10k
// and below". It is a rule of thumb about how the company works, not a
// constraint on the data — so nothing here refuses a bigger one. The screen
// says the number out loud and lets a person decide.
const SERVICE_TICKET_SOFT_CEILING = 10000;

function text(v) {
  return v == null ? '' : String(v).trim();
}

function parseData(v) {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  try {
    const parsed = JSON.parse(v || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (e) {
    return {};
  }
}

// Is this one of the two words a convert may name?
function convertKind(raw) {
  const word = text(raw).toLowerCase();
  return CONVERT_KINDS.indexOf(word) >= 0 ? word : null;
}

// THE SCOPE COMES FROM THE SAME GROUPS THE PRICE DOES.
//
// An estimate's proposal total (services/money/estimate-totals.js) is the sum
// of every alternate that is INCLUDED — `excludeFromTotal` falsy. So the scope
// carried onto the ticket is the scope text of exactly those groups, and the
// two can never describe different work: an optional "Better" package that was
// priced but not sold does not arrive as scope on a ticket nobody sold it on.
//
// A group's name is written above its scope ONLY when more than one group was
// included, because on the ordinary single-group estimate "Base" above the
// text is noise.
//
// est.scopeOfWork is the pre-alternates shape (js/estimate-editor.js migrates
// it into the first group on open, so it survives only on estimates nobody has
// opened since). It answers when no included group carries a scope of its own.
function estimateScope(data) {
  const est = parseData(data);
  const alts = Array.isArray(est.alternates) ? est.alternates : [];
  const included = alts.filter((a) => a && !a.excludeFromTotal);
  const parts = [];
  for (const alt of included) {
    const scope = text(alt.scope);
    if (!scope) continue;
    const name = text(alt.name || alt.title);
    parts.push(included.length > 1 && name ? name + '\n' + scope : scope);
  }
  if (parts.length) return parts.join('\n\n');
  return text(est.scopeOfWork);
}

// What a ticket takes from the lead it was converted from. Copied, never
// joined — the same rule the address columns on service_tickets already
// follow: a work order is a document that travels, and correcting the lead's
// address next month must not silently reprint the ticket somebody worked to.
//
// NOT carried: the lead's receipts. They stay pre-sale costs on the lead until
// there is somewhere on a ticket for a cost to live, which is the billing
// phase. Moving them now would file them where nothing can show them.
function ticketFromLead(lead, opts) {
  const l = lead || {};
  const o = opts || {};
  const values = {
    title: text(o.title) || text(l.title),
    client_id: l.client_id || null,
    street_address: text(l.street_address) || null,
    city: text(l.city) || null,
    state: text(l.state) || null,
    zip: text(l.zip) || null,
  };
  // The address travels as a SET or not at all. street_address alone is what
  // ticketAddressProblem() requires before a city/state/zip may be written,
  // and a lead that only ever recorded a city would otherwise make a ticket
  // the office cannot save again.
  if (!values.street_address) {
    values.city = null;
    values.state = null;
    values.zip = null;
  }
  return values;
}

// The estimate blob, however the column handed it over (jsonb on Postgres, a
// string on anything that stores it as text). Never throws: a blob nobody
// can parse reads as empty, which refuses a sale rather than allowing one.
function estimateBlob(data) {
  return parseData(data);
}

module.exports = {
  CONVERT_KINDS,
  estimateBlob,
  KIND_REQUIRED,
  ALREADY_A_JOB,
  ALREADY_A_TICKET,
  ESTIMATE_SOLD_TO_JOB,
  ESTIMATE_SOLD_TO_TICKET,
  SERVICE_TICKET_SOFT_CEILING,
  convertKind,
  estimateScope,
  ticketFromLead,
};
