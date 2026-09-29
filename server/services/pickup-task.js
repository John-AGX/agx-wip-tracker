'use strict';

// A PICKUP IS AN ERRAND, NOT CREW WORK.
//
// John, 2026-09-18, after 86 refused a service ticket for a Lowe's collection
// (order 300901261260239973, 96" aluminium soffit vents, qty 49, Plant City
// Pro Desk, due that day): a work order needs a job or lead parent, and an
// errand has neither. Forcing one into a work order means inventing a parent
// job, and a work order carries a scope, a punch list, photo-as-proof per
// building and an approval — none of which an errand has.
//
// So a pickup is a TASK with kind 'pickup'. Tasks already carry everything
// the shape needs except the supplier detail: a due date, an assignee, an
// OPTIONAL polymorphic entity link (a job link is optional; an errand can
// stand alone), lat/lng with directions, attachments, and a share link an
// outside runner can use with no login (task_shares). What this module adds
// is the supplier half and the one rule that is genuinely different.
//
// THE ONE RULE: A PICKUP IS NOT COLLECTED WITHOUT PROOF. A photo of the
// receipt or the pickup ticket is what says the errand actually happened,
// the same way a completion photo is what says a building is finished
// (svc.subtaskMayComplete). It is asked in ONE place here so the office door
// and the runner's share link cannot answer it differently — which is
// exactly how the work-order rule went wrong before 1.29.
//
// NO PRICES. The items are what to COLLECT — quantity, unit, description.
// A pickup goes to a runner or a sub on a link, and what the company pays
// for soffit vents is not their business. There is no price field to leave
// blank: the shape has nowhere to put one.

const KIND = 'pickup';

const STORE_MAX = 120;
const BRANCH_MAX = 120;
const REF_MAX = 80;
const PHONE_MAX = 40;
const ADDRESS_MAX = 300;
const DESC_MAX = 300;
const UNIT_MAX = 24;
const NOTE_MAX = 2000;
const ITEMS_MAX = 100;
const QTY_MAX = 1000000;

// 'HH:MM', 24-hour. A window is a pair on the task's DUE DATE — a pickup is
// "today between 8 and 12", never a span of days, so there is deliberately
// no second date to disagree with due_date.
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

const MSG = Object.freeze({
  notPickup: 'That task is not a pickup.',
  store: 'Say which supplier this is from.',
  items: 'Say what to collect.',
  itemQty: 'Every line needs a quantity above zero.',
  itemDesc: 'Every line needs a description.',
  tooMany: 'A pickup carries at most ' + ITEMS_MAX + ' lines.',
  time: 'A time window looks like 08:00.',
  window: 'The window ends before it starts.',
  needsProof:
    'Add a photo of the receipt or the pickup ticket before marking this collected.',
});

function isPickup(task) {
  return !!task && String(task.kind || '') === KIND;
}

function str(v, max) {
  const s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
}

/** Multi-line text kept as typed, only trimmed and capped. */
function text(v, max) {
  const s = String(v == null ? '' : v).replace(/\r\n/g, '\n').trim();
  return s ? s.slice(0, max) : null;
}

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * validateItems(raw) -> {ok, items} | {ok:false, error}
 * WHAT TO COLLECT: quantity, unit, description. No price, ever — see the
 * header. A line with no description is a mistake, not a blank row, because
 * a runner reading it has nothing to go and find.
 */
function validateItems(raw) {
  if (!Array.isArray(raw)) return { ok: false, error: MSG.items };
  const list = raw.filter(function (r) { return r && typeof r === 'object'; });
  if (!list.length) return { ok: false, error: MSG.items };
  if (list.length > ITEMS_MAX) return { ok: false, error: MSG.tooMany };
  const items = [];
  for (const row of list) {
    const description = str(row.description, DESC_MAX);
    if (!description) return { ok: false, error: MSG.itemDesc };
    const qty = num(row.qty);
    if (qty == null || qty <= 0 || qty > QTY_MAX) return { ok: false, error: MSG.itemQty };
    items.push({
      qty: Math.round(qty * 100) / 100,
      unit: str(row.unit, UNIT_MAX),
      description: description,
      // Ticked by whoever collects it, so a partial pickup is legible.
      got: row.got === true,
    });
  }
  return { ok: true, items: items };
}

/**
 * validate(body) -> {ok, pickup} | {ok:false, error}
 * The supplier half of a pickup task. Everything else — title, due date,
 * assignee, the optional job link, the pin — is an ordinary task field and
 * is written by the task door that already owns it.
 */
function validate(body) {
  const b = body || {};
  const store = str(b.store, STORE_MAX);
  if (!store) return { ok: false, error: MSG.store };

  const items = validateItems(b.items);
  if (!items.ok) return items;

  const from = str(b.window_start, 5);
  const to = str(b.window_end, 5);
  for (const t of [from, to]) {
    if (t && !TIME_RE.test(t)) return { ok: false, error: MSG.time };
  }
  // Both ends or neither is not required — "any time before 12" is a real
  // instruction — but a pair that runs backwards is a typo.
  if (from && to && to < from) return { ok: false, error: MSG.window };

  return {
    ok: true,
    pickup: {
      v: 1,
      store: store,
      branch: str(b.branch, BRANCH_MAX),
      // The order / reference number. Searchable — the task list's `q`
      // matches it as well as the title, because "what was that Lowe's
      // order" is how somebody actually looks for one of these.
      order_ref: str(b.order_ref, REF_MAX),
      phone: str(b.phone, PHONE_MAX),
      address: str(b.address, ADDRESS_MAX),
      window_start: from,
      window_end: to,
      note: text(b.note, NOTE_MAX),
      items: items.items,
    },
  };
}

/** Merge a patch over a stored pickup, so a partial edit keeps the rest. */
function merge(current, body) {
  const base = (current && typeof current === 'object') ? current : {};
  const b = body || {};
  const has = function (k) { return Object.prototype.hasOwnProperty.call(b, k); };
  const next = {
    store: has('store') ? b.store : base.store,
    branch: has('branch') ? b.branch : base.branch,
    order_ref: has('order_ref') ? b.order_ref : base.order_ref,
    phone: has('phone') ? b.phone : base.phone,
    address: has('address') ? b.address : base.address,
    window_start: has('window_start') ? b.window_start : base.window_start,
    window_end: has('window_end') ? b.window_end : base.window_end,
    note: has('note') ? b.note : base.note,
    items: has('items') ? b.items : (Array.isArray(base.items) ? base.items : []),
  };
  return validate(next);
}

/**
 * mayComplete(task, photos) -> {ok:true} | {ok:false, error}
 * THE PROOF RULE, asked in one place by both doors.
 *
 * Only a pickup is held to it. Every other kind of task completes exactly as
 * it always has — this must never become "no task completes without a
 * photo", which would break every checklist to-do in the app.
 */
function mayComplete(task, photos) {
  if (!isPickup(task)) return { ok: true };
  const list = Array.isArray(photos) ? photos : [];
  const any = list.some(function (p) {
    return p && /^image\//i.test(String(p.mime_type || p.mime || ''));
  });
  return any ? { ok: true } : { ok: false, error: MSG.needsProof };
}

/**
 * A pickup's own SQL for the task list's `q`: the order reference, matched
 * alongside the title. `alias` is the table alias; it is validated rather
 * than interpolated blind, because this string is concatenated into SQL.
 */
function searchSql(alias) {
  const a = String(alias || 't');
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(a)) throw new Error('pickup-task: bad alias ' + a);
  return a + ".pickup->>'order_ref'";
}

/** What a runner on a share link may see. Projection by INCLUSION. */
function publicPickup(pickup) {
  const p = (pickup && typeof pickup === 'object') ? pickup : null;
  if (!p) return null;
  return {
    store: p.store || null,
    branch: p.branch || null,
    order_ref: p.order_ref || null,
    phone: p.phone || null,
    address: p.address || null,
    window_start: p.window_start || null,
    window_end: p.window_end || null,
    note: p.note || null,
    // qty / unit / description / got. There is no price in the stored shape
    // at all, so this cannot leak one — but the projection is by inclusion
    // anyway, so a field added later does not travel by default.
    items: (Array.isArray(p.items) ? p.items : []).map(function (i) {
      return { qty: i.qty, unit: i.unit || null, description: i.description, got: i.got === true };
    }),
  };
}

module.exports = {
  KIND, MSG, TIME_RE, ITEMS_MAX, DESC_MAX, UNIT_MAX, REF_MAX,
  isPickup, validate, validateItems, merge, mayComplete, searchSql, publicPickup,
};
