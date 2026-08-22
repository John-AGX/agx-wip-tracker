#!/usr/bin/env node
'use strict';

/**
 * co-clock-census.js — THE SHIP GATES FOR THE ONE-CLOCK PORT, run where the DB is.
 *
 * The port that converged change-order earned revenue onto the scope clock
 * (js/co-completion.js, required by server/services/money/job-wip.js) moves live
 * numbers on every job carrying an unlinked change order. It was designed and
 * tested with NO database reachable, so the four censuses that tell John HOW
 * MUCH could not be run. This is them. Read-only: it opens a connection, runs
 * SELECTs, prints, and exits. It writes nothing and it is not wired into the app.
 *
 *   node scripts/co-clock-census.js                 # summary + top 25 by |Δ|
 *   node scripts/co-clock-census.js --all           # every job
 *   node scripts/co-clock-census.js --csv > out.csv # G2 as CSV
 *
 * G1 · DEAD RIDER SCOPES. Rider COs whose riderScopeName matches no live scope
 *      on the job. These earn $0 on the server after the port (they already
 *      earn $0 in the browser — that is the convergence). Count and dollars.
 *      This is the largest single move per CO; John sees it before it ships.
 *
 * G2 · THE DELTA. Per job: coEarned before (Σ unlinked income × job.pctComplete)
 *      and after (Σ per-CO scope clock), and the Δ that flows into revenueEarned
 *      → jtdProfit → jtdMargin → displayProfit/displayMargin, NEGATED into
 *      backlog, and ADDED to unbilled. Note `unbilled` looks like billing and is
 *      not: `invoiced` is frozen AR, so only the earned side reprices and the
 *      GAP changes on jobs nobody touched.
 *
 * G3 · WHITESPACE. Rider COs whose riderScopeName matches a live scope only
 *      after trim. These earn $0 today and js/job-audit.js R11 — which trims
 *      both sides — calls them healthy. The clock does not trim, on purpose:
 *      trimming would RESTORE revenue on every damaged CO as a side effect of a
 *      port. Fix them by re-pointing the CO, then the money returns visibly.
 *
 * G4 · THE LEGACY CHAIN. Phase rows where the TRUTHY chain and the NULL chain
 *      disagree — the Saddlebrook shape {asSoldRevenue: 0, asSoldPhaseBudget: N}.
 *      The rider clock weights on TRUTHY; progress-core's jobPct (which the
 *      legacy CO branch uses, and which a future base-contract convergence
 *      would use) reads NULL and sees $0. This is the census that must exist
 *      before anyone promotes the null chain to authority over the WIP, 86's
 *      per-turn context and the guest-visible Live Rooms chip.
 */

const { coCompletion } = require('../js/co-completion.js');
const core = require('../js/progress-core.js');
const jobMoney = require('../server/services/money/change-order-totals.js');

const ARGS = new Set(process.argv.slice(2));
const ALL = ARGS.has('--all');
const CSV = ARGS.has('--csv');

const num = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };
const money = (n) => (n < 0 ? '-' : '') + '$' + Math.abs(Math.round(n)).toLocaleString('en-US');

async function main() {
  const db = require('../server/db.js');
  const pool = db.pool || db;

  const jobs = await pool.query(
    "SELECT id, data FROM jobs ORDER BY (data->>'jobNumber') NULLS LAST");
  const ids = jobs.rows.map((r) => r.id);
  const coByJob = await jobMoney.changeOrdersForJobs(pool, ids);

  const g1 = [];       // dead rider scopes
  const g2 = [];       // per-job delta
  const g3 = [];       // whitespace-only matches
  let g4Rows = 0, g4Dollars = 0, g4Jobs = 0;

  for (const row of jobs.rows) {
    const d = row.data || {};
    const phases = Array.isArray(d.phases) ? d.phases : [];
    const buildings = Array.isArray(d.buildings) ? d.buildings : [];
    const storedPct = num(d.pctComplete);
    const jobNumber = d.jobNumber || '(none)';
    const title = d.title || d.jobName || '(untitled)';

    // G4 — the two phaseRevenue chains, per row.
    let jobG4 = 0;
    for (const p of phases) {
      const truthy = p.asSoldRevenue || p.asSoldPhaseBudget || p.phaseBudget || 0;
      const nul = core.phaseRevenueNull(p);
      if (num(truthy) !== nul) { jobG4++; g4Rows++; g4Dollars += Math.abs(num(truthy) - nul); }
    }
    if (jobG4) g4Jobs++;

    // Same fallback the org rollup uses: table rows, else the raw blob array.
    const cos = coByJob.get(row.id) || (Array.isArray(d.changeOrders) ? d.changeOrders : []);
    let before = 0, after = 0;
    const liveScopes = new Set(phases.map((p) => String(p.phase || 'Unnamed')));
    const trimmedScopes = new Map();
    for (const s of liveScopes) trimmedScopes.set(s.trim(), s);

    for (const c of cos) {
      if (!c || c.linked_node_id) continue;              // the port's exact predicate
      const sell = num(c.income);
      before += sell * (storedPct / 100);
      const r = coCompletion(c, { sell, cost: num(c.costs), phases, buildings, storedPct });
      after += num(r.earned);

      const mode = (c.completionMode || (c.data && c.data.completionMode)) || '';
      if (mode === 'rider') {
        const name = (c.riderScopeName || (c.data && c.data.riderScopeName)) || '';
        if (r.riderScopeMissing) {
          const whitespaceOnly = trimmedScopes.has(String(name).trim());
          const rec = { jobNumber, title, co: c.coNumber || c.id, scope: JSON.stringify(name), sell };
          if (whitespaceOnly) {
            rec.livesAs = JSON.stringify(trimmedScopes.get(String(name).trim()));
            g3.push(rec);
          } else {
            g1.push(rec);
          }
        }
      }
    }

    const delta = after - before;
    if (Math.abs(delta) > 0.005 || ALL) {
      g2.push({ id: row.id, jobNumber, title, before, after, delta,
        dRevenueEarned: delta, dDisplayProfit: delta, dBacklog: -delta, dUnbilled: delta });
    }
  }

  if (CSV) {
    console.log('jobId,jobNumber,title,coEarned_old,coEarned_new,d_revenueEarned,d_displayProfit,d_backlog,d_unbilled');
    for (const r of g2.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))) {
      console.log([r.id, r.jobNumber, JSON.stringify(r.title), r.before.toFixed(2), r.after.toFixed(2),
        r.dRevenueEarned.toFixed(2), r.dDisplayProfit.toFixed(2), r.dBacklog.toFixed(2), r.dUnbilled.toFixed(2)].join(','));
    }
    await pool.end();
    return;
  }

  const line = (s) => console.log(s);
  line('');
  line('══ G1 · RIDER COs WHOSE SCOPE IS GONE — these go to $0 on the server ══');
  line(`   ${g1.length} change order(s), ${money(g1.reduce((s, r) => s + r.sell, 0))} of contract value`);
  for (const r of g1) line(`   ${r.jobNumber} ${r.co}  rides ${r.scope}  ${money(r.sell)}  — ${r.title}`);
  if (!g1.length) line('   (none)');

  line('');
  line('══ G3 · WHITESPACE-ONLY MISMATCHES — earning $0 today; R11 calls them healthy ══');
  line(`   ${g3.length} change order(s), ${money(g3.reduce((s, r) => s + r.sell, 0))}`);
  for (const r of g3) line(`   ${r.jobNumber} ${r.co}  rides ${r.scope}  but the scope lives as ${r.livesAs}  ${money(r.sell)}`);
  if (!g3.length) line('   (none)');

  line('');
  line('══ G4 · THE TWO phaseRevenue CHAINS DISAGREE — do NOT promote the null chain until this is $0 ══');
  line(`   ${g4Rows} phase row(s) across ${g4Jobs} job(s); ${money(g4Dollars)} reads as $0 on the NULL chain`);

  line('');
  line('══ G2 · THE DELTA — coEarned before → after, per job ══');
  const sorted = g2.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  const shown = ALL ? sorted : sorted.slice(0, 25);
  line('   job          coEarned old      coEarned new      Δ earned/profit    Δ backlog');
  for (const r of shown) {
    line(`   ${String(r.jobNumber).padEnd(12)} ${money(r.before).padStart(15)} ${money(r.after).padStart(17)} ` +
      `${money(r.delta).padStart(17)} ${money(r.dBacklog).padStart(12)}   ${r.title}`);
  }
  if (!shown.length) line('   (no job moves)');
  const up = sorted.filter((r) => r.delta > 0), down = sorted.filter((r) => r.delta < 0);
  line('');
  line(`   ${sorted.length} job(s) move. ${up.length} up (${money(up.reduce((s, r) => s + r.delta, 0))}), ` +
    `${down.length} down (${money(down.reduce((s, r) => s + r.delta, 0))}).`);
  line('   Δ flows: revenueEarned → jtdProfit → jtdMargin → displayProfit/displayMargin,');
  line('   NEGATED into backlog, ADDED to unbilled. `unbilled` is NOT billing — invoiced');
  line('   is frozen AR, so only the earned side reprices and the GAP moves on jobs');
  line('   nobody touched. No issued G702/G703 or invoice changes value.');
  line('');

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
