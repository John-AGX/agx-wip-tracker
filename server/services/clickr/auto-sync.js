// THE UNATTENDED RUN.
//
// The owner's decision, twice stated: Buildertrend is the source of truth and
// Project 86 follows it completely, money included, without waiting to be
// asked. The safety is not a confirm step — it is that every write goes down
// the SAME journalled path a press does (services/clickr/sync-journal.js), so
// anything this does can be taken back afterwards.
//
// OFF BY DEFAULT, and it stays off until BT_AUTO_SYNC is set. A runner that
// began writing the moment it deployed would be the one thing nobody asked
// for; turning it on is a decision somebody makes on purpose, once.
//
// ORDER IS THE WHOLE DESIGN. A change order, purchase order, bill, estimate
// worksheet or task whose Buildertrend job is not a linked P86 job can do
// nothing at all. So clients and jobs are reconciled FIRST, and the datasets
// that hang off a job are read afterwards — each apply() re-reads the P86 side,
// so a job created earlier in the same run is already there to hang them on.
// One pass in this order does what two passes in any other order would.
'use strict';

const syncApply = require('./sync-apply');
const preview = require('./sync-preview');
const journal = require('./sync-journal');

// Parents before children. Not PREVIEW_KINDS' order, and not alphabetical:
// this is the dependency order, and a dataset moved up it will silently stop
// finding its job.
const ORDER = ['clients', 'jobs', 'leads', 'changeOrders', 'purchaseOrders', 'bills', 'estimates', 'tasks'];

// A held-back item is money, or a match key, that a press requires a person to
// tick. An unattended run ticks them — that is what the owner chose — with ONE
// exception, named here rather than buried in a branch:
//
//   reason 'permanent'  an offer whose press cannot be walked back by putting a
//                       column value back. Closing a purchase order is the only
//                       one today: the row itself says a closed PO cannot be
//                       edited, unlocked, revised by addendum or deleted BY
//                       ANYONE. The undo spine restores columns; it does not
//                       restore what a closed PO refuses to let anybody do
//                       afterwards. So this run leaves those for a person, and
//                       says how many it left.
function ticksFor(row) {
  const out = [];
  for (const c of row.corrections || []) if (c.field) out.push(c.field);
  for (const h of row.heldBack || []) {
    if (h.applicable !== true || !h.field) continue;
    if (h.reason === 'permanent') continue;
    out.push(h.field);
  }
  return [...new Set(out)];
}

function permanentCount(rows) {
  let n = 0;
  for (const r of rows || []) {
    for (const h of r.heldBack || []) if (h.applicable === true && h.reason === 'permanent') n++;
  }
  return n;
}

// The rows a money pass has anything to say about: matched or conflict (a row
// that is already linked, or confidently matched), carrying at least one
// applicable held-back item. 'new' rows are the create pass's business, and an
// ambiguous row is never acted on by anything.
function moneyTargets(rows) {
  const out = [];
  for (const r of rows || []) {
    if (r.class !== 'matched' && r.class !== 'conflict') continue;
    const btId = r.bt && r.bt.btId;
    if (!btId) continue;
    const fields = ticksFor(r);
    if (!fields.length) continue;
    out.push({ btId: String(btId), fields });
  }
  return out;
}

// Every distinct field any target names, so one call can carry them all: apply()
// filters per row against that row's own applicable items, so a field named for
// one record cannot reach another that did not offer it.
function batchFor(targets) {
  const btIds = targets.map((t) => t.btId);
  const fields = [...new Set(targets.reduce((a, t) => a.concat(t.fields), []))];
  return { btIds, fields };
}

function enabled(env) {
  const v = String((env && env.BT_AUTO_SYNC) || '').trim().toLowerCase();
  return v === 'on' || v === '1' || v === 'true' || v === 'yes';
}

async function ownerOrg(pool, env) {
  const slug = preview.ownerSlug(env);
  const r = await pool.query('SELECT id, slug, name FROM organizations WHERE slug = $1', [slug]);
  return r.rows[0] || null;
}

// Read the dataset once and match it, the same way the preview does, so the
// money pass can see which rows are offering what. apply() does its own read
// and its own match before it writes — this one only decides what to name.
async function look(org, kind, deps) {
  const rows = await syncApply.rowsFor(org, kind, deps);
  return rows || [];
}

// ── one run ───────────────────────────────────────────────────────────────
// Returns a report; never throws. A dataset that fails is recorded and the
// rest of the run carries on: one bad read must not stop the other seven.
async function runOnce(deps) {
  const env = deps.env || process.env;
  const pool = deps.pool;
  if (!enabled(env)) return { skipped: 'BT_AUTO_SYNC is not on.' };
  if (!String(env.CLICKR_API_KEY || '').trim()) return { skipped: 'No Clickr key on this server.' };

  const org = await ownerOrg(pool, env);
  if (!org) return { skipped: 'No organization matches CLICKR_ORG_SLUG.' };

  const runId = await journal.startRunOn(pool, org.id, { trigger: 'schedule', dataset: null, mode: 'auto', userId: null });
  const report = { runId, org: org.slug, datasets: {}, permanentLeft: 0, startedAt: new Date().toISOString() };
  const totals = { applied: 0, created: 0, linked: 0, unchanged: 0, skipped: 0, failed: 0, money: 0 };

  for (const kind of ORDER) {
    const d = { safe: null, create: null, money: null, error: null, permanentLeft: 0 };
    try {
      // 1. Link every confident match and apply what carries no money.
      d.safe = await call(org, { dataset: kind, mode: 'safe' }, deps, runId);
      // 2. Bring across what Buildertrend has and P86 does not.
      d.create = await call(org, { dataset: kind, mode: 'create', btIds: [] }, deps, runId);
      // 3. The money, and the match keys a press makes a person tick.
      const rows = await look(org, kind, deps);
      d.permanentLeft = permanentCount(rows);
      const targets = moneyTargets(rows);
      if (targets.length) {
        const b = batchFor(targets);
        d.money = await call(org, { dataset: kind, mode: 'rows', btIds: b.btIds, fields: b.fields }, deps, runId);
      }
    } catch (e) {
      d.error = (e && e.message) || 'failed';
    }
    for (const phase of ['safe', 'create', 'money']) {
      const c = d[phase] && d[phase].counts;
      if (!c) continue;
      for (const k of Object.keys(totals)) if (typeof c[k] === 'number') totals[k] += c[k];
      if (phase === 'money' && typeof c.applied === 'number') totals.money += c.applied;
    }
    report.permanentLeft += d.permanentLeft;
    report.datasets[kind] = d;
  }

  report.totals = totals;
  report.finishedAt = new Date().toISOString();
  await journal.finishRunOn(pool, org.id, runId, totals);
  report.dropped = await journal.dropEmptyRunOn(pool, org.id, runId);
  return report;
}

// One apply, on the run's own journal id, never throwing at the caller.
async function call(org, input, deps, runId) {
  const out = await syncApply.apply(org, input, Object.assign({}, deps, { journalRun: runId, user: null }));
  return { status: out.status, counts: (out.body && out.body.counts) || null, error: out.body && out.body.error ? out.body.error : null };
}

module.exports = { runOnce, ORDER, ticksFor, permanentCount, moneyTargets, batchFor, enabled, ownerOrg };
