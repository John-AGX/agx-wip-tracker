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
 *      THE Δ DOES NOT LAND ON EVERY JOB. computeJobWIP folds coEarned in on
 *      ONE branch only:
 *
 *        revenueEarned = job.ngRevenueEarned != null
 *          ? num(job.ngRevenueEarned) + coEarned      // Δ lands
 *          : totalIncome * (storedPct / 100);         // coEarned DISCARDED
 *
 *      On the null branch coEarned is computed and thrown away — the fallback
 *      already folds all CO income into totalIncome × pct — so a job with no
 *      graph-pushed earned revenue moves by exactly $0 no matter what its
 *      clock delta is. ngRevenueEarned is written in one place only
 *      (nodegraph/ui.js), so on a node-retired job it is simply absent.
 *
 *      Backlog has its own gate, and it is the COMPLEMENT of that one:
 *
 *        backlog = job.ngBacklog != null ? num(job.ngBacklog)   // stored, frozen
 *                                        : totalIncome - revenueEarned;
 *
 *      nodegraph/ui.js writes ngBacklog in the same block as ngRevenueEarned,
 *      so the usual job has BOTH or NEITHER: with neither, nothing moves at
 *      all; with both, earned/profit/unbilled move and backlog does not. Δ
 *      backlog = −Δ therefore held on almost no job in this database.
 *
 *      This census is what John was told to run BEFORE trusting the new WIP,
 *      so it reports only what actually reaches a stored number. Jobs whose Δ
 *      lands nowhere are NOT dropped — they are listed, flagged, counted, and
 *      left out of the totals, with the reason printed.
 *
 *      ONE STATED RESIDUAL: displayProfit has a third gate,
 *      `hasActuals = actualCosts > 0 || revenueEarned > 0`, and on the false
 *      branch it reads revisedProfit, which has no revenueEarned term. This
 *      script does not load qb_cost_lines, so it cannot evaluate actualCosts
 *      and does not model that gate. It can only ever SUPPRESS a Δ, never add
 *      one, so the Δ displayProfit total below is an upper bound.
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

/**
 * Where a job's clock Δ actually lands — the two branches computeJobWIP takes.
 * A census that reports a Δ which reaches no stored number overstates the port,
 * and this one is the gate John was told to run BEFORE trusting the new WIP.
 *
 *   revenueEarned = ngRevenueEarned != null ? ngRevenueEarned + coEarned
 *                                           : totalIncome × storedPct   ← Δ dropped
 *   backlog       = ngBacklog       != null ? ngBacklog                  ← frozen
 *                                           : totalIncome − revenueEarned
 *
 * Exported so test/co-clock-census-truth.test.js can hold it against what
 * server/services/money/job-wip.js really does, rather than against a comment.
 * If that file ever folds coEarned in on both branches, the exclusion printed
 * below becomes a lie and the test says so.
 */
function deltaLanding(jobData) {
  const d = jobData || {};
  const landsInEarned = d.ngRevenueEarned != null;
  return { landsInEarned, landsInBacklog: landsInEarned && d.ngBacklog == null };
}

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

    const { landsInEarned, landsInBacklog } = deltaLanding(d);

    if (Math.abs(delta) > 0.005 || ALL) {
      g2.push({ id: row.id, jobNumber, title, before, after, delta,
        landsInEarned, landsInBacklog,
        // The clock moved by `delta`. These four are what a stored number
        // actually does — 0 where the branch throws the movement away.
        dRevenueEarned: landsInEarned ? delta : 0,
        dDisplayProfit: landsInEarned ? delta : 0,
        dUnbilled: landsInEarned ? delta : 0,
        dBacklog: landsInBacklog ? -delta : 0 });
    }
  }

  if (CSV) {
    // d_clock is the raw clock movement; the d_* columns after it are what a
    // stored number actually does. They differ wherever lands_in_* is false —
    // hence the flags being columns rather than a filter.
    console.log('jobId,jobNumber,title,coEarned_old,coEarned_new,d_clock,' +
      'lands_in_earned,lands_in_backlog,d_revenueEarned,d_displayProfit,d_backlog,d_unbilled');
    for (const r of g2.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))) {
      console.log([r.id, r.jobNumber, JSON.stringify(r.title), r.before.toFixed(2), r.after.toFixed(2),
        r.delta.toFixed(2), r.landsInEarned, r.landsInBacklog,
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
  line('   job          coEarned old      coEarned new       Δ clock     Δ earned/profit    Δ backlog');
  for (const r of shown) {
    // The marker is why a row's Δ earned is $0 despite a non-zero clock Δ.
    const mark = !r.landsInEarned ? '  ‡' : (!r.landsInBacklog ? '  †' : '');
    line(`   ${String(r.jobNumber).padEnd(12)} ${money(r.before).padStart(15)} ${money(r.after).padStart(17)} ` +
      `${money(r.delta).padStart(13)} ${money(r.dRevenueEarned).padStart(15)} ${money(r.dBacklog).padStart(12)}${mark}   ${r.title}`);
  }
  if (!shown.length) line('   (no job moves)');

  // Totals are built from what LANDS, never from the raw clock Δ. An
  // instrument that overstates is worse than no instrument, and this one is
  // the gate John was told to run before trusting the new WIP.
  const landing = sorted.filter((r) => r.landsInEarned);
  const stranded = sorted.filter((r) => !r.landsInEarned);
  const noBacklog = landing.filter((r) => !r.landsInBacklog);
  const up = landing.filter((r) => r.delta > 0), down = landing.filter((r) => r.delta < 0);
  line('');
  line(`   ${sorted.length} job(s) have a non-zero clock Δ; ${landing.length} of them actually move a stored number.`);
  line(`   ${up.length} up (${money(up.reduce((s, r) => s + r.dRevenueEarned, 0))}), ` +
    `${down.length} down (${money(down.reduce((s, r) => s + r.dRevenueEarned, 0))}).`);
  line(`   Σ Δ revenueEarned / displayProfit ${money(landing.reduce((s, r) => s + r.dRevenueEarned, 0))} · ` +
    `Σ Δ unbilled ${money(landing.reduce((s, r) => s + r.dUnbilled, 0))} · ` +
    `Σ Δ backlog ${money(sorted.reduce((s, r) => s + r.dBacklog, 0))}`);
  line('');
  line(`   ‡ EXCLUDED FROM THE TOTALS — ${stranded.length} job(s), ${money(stranded.reduce((s, r) => s + r.delta, 0))} of clock Δ.`);
  line('     These have job.ngRevenueEarned == null, and on that branch computeJobWIP');
  line('     discards coEarned entirely (revenueEarned = totalIncome × storedPct, which');
  line('     already folds in all CO income). Their Δ is real on the clock and reaches');
  line('     no stored number, so counting it would overstate the port. They are listed');
  line('     above rather than dropped. ngRevenueEarned is written only by nodegraph/ui.js,');
  line('     so a node-retired job simply does not have one.');
  line('');
  line(`   † BACKLOG DOES NOT MOVE — ${noBacklog.length} of the ${landing.length} landing job(s) also carry a stored`);
  line('     job.ngBacklog, and `backlog` prefers it over totalIncome − revenueEarned. Their');
  line('     earned/profit/unbilled move; their backlog is frozen. Δ backlog = −Δ holds only');
  line('     where ngRevenueEarned is set AND ngBacklog is not.');
  line('');
  line('   Δ flows: revenueEarned → jtdProfit → jtdMargin → displayProfit/displayMargin,');
  line('   NEGATED into backlog, ADDED to unbilled. `unbilled` is NOT billing — invoiced');
  line('   is frozen AR, so only the earned side reprices and the GAP moves on jobs');
  line('   nobody touched. No issued G702/G703 or invoice changes value.');
  line('   Δ displayProfit is an UPPER BOUND: its `hasActuals` gate needs qb_cost_lines,');
  line('   which this script does not load. That gate can only suppress a Δ, never add one.');
  line('');

  await pool.end();
}

module.exports = { deltaLanding };

// Still a script first: `node scripts/co-clock-census.js` runs. The guard is
// what lets a test require() the classifier without opening a DB connection —
// main() is the only thing in this file that touches server/db.js.
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
