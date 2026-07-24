// Promise confirm. Native confirm() returns undefined inside an installed PWA,
// so every `if (!confirm(x)) return` guard silently did nothing there: the
// dialog never appeared and the action never ran. Uses the in-app overlay when
// present, native only as a fallback.
function p86Ask(message, opts) {
  opts = opts || {};
  if (typeof window.p86Confirm === 'function') {
    return window.p86Confirm({
      title: opts.title || 'Confirm', message: message,
      confirmLabel: opts.confirmLabel || 'Confirm', confirmText: opts.confirmLabel || 'Confirm',
      cancelLabel: 'Cancel', cancelText: 'Cancel',
      danger: opts.danger !== false, destructive: opts.danger !== false
    });
  }
  return Promise.resolve(window.confirm(message));
}
function renderJobsMain() {
            renderJobsTable();
            calculateJobsSummary();
        }

        // _confirmDelete — shorthand for the "are you sure you want to
        // delete X" pattern that's repeated across this file. Uses the
        // in-house dialog when available (js/dialogs.js) and falls back
        // to native confirm() so existing flows still work pre-load.
        // Always returns a Promise<boolean>.
        function _confirmDelete(label, opts) {
            opts = opts || {};
            var msg = opts.message || ('Delete this ' + label + '?' +
                (opts.note ? '\n\n' + opts.note : ''));
            if (typeof window.p86Confirm === 'function') {
                // Two p86Confirm impls ship (dialogs.js + app.js) with different
                // option names — pass both spellings so the Delete label and the
                // danger styling apply whichever one is live.
                return window.p86Confirm({
                    title: opts.title || ('Delete ' + label),
                    message: msg,
                    confirmLabel: opts.confirmLabel || 'Delete',
                    confirmText: opts.confirmLabel || 'Delete',
                    cancelLabel: opts.cancelLabel || 'Cancel',
                    cancelText: opts.cancelLabel || 'Cancel',
                    danger: opts.danger !== false,
                    destructive: opts.danger !== false
                });
            }
            return Promise.resolve(window.confirm(msg));
        }

        // Format a wire-allocation percentage for display only — the
        // underlying allocPct stays at full float precision so sums
        // still equal 100% exactly. Rules:
        //   - within 0.05 of an integer → render as integer (so 100/7
        //     drift of `14.285714285405622` and clean `14.285714285714286`
        //     both display as "14")
        //   - otherwise → 1 decimal
        // Without this, raw float concatenation surfaced strings like
        // "14.285714285714286%" in the building-detail panel. See
        // memoized-inventing-mountain.md (allocPct UI rounding task).
        function fmtAllocPct(v) {
            if (v == null || !isFinite(v)) return '';
            var rounded = Math.round(v);
            if (Math.abs(v - rounded) < 0.05) return String(rounded);
            return v.toFixed(1);
        }

        // Sub assignments are job-level only — building/phase
        // distribution is driven by the node graph. The two
        // ForBuilding helpers still distribute job-level totals
        // pro-rata by building budget so the legacy WIP rollup
        // surfaces a building number; phase-level rollups go to
        // zero (the graph drives those numbers now).

        function getSubCostForPhase(_phaseId) {
            return 0;
        }

        function distributeJobTotalAcrossBuildings(jobId, total, thisBldgId) {
            if (total <= 0) return 0;
            const thisBldg = appData.buildings.find(b => b.id === thisBldgId);
            if (thisBldg && thisBldg.excludeFromSubDist) return 0;
            const buildings = appData.buildings.filter(b => b.jobId === jobId && !b.excludeFromSubDist);
            if (buildings.length === 0) return 0;
            // Weight by each building's phase-derived budget (the real budget in
            // the derive-from-phases model), not the stale raw building.budget.
            const totalBudget = buildings.reduce((sum, b) => sum + buildingEffectiveBudget(b, jobId).amount, 0);
            if (totalBudget > 0) {
                const bldgPct = (thisBldg ? buildingEffectiveBudget(thisBldg, jobId).amount : 0) / totalBudget;
                return total * bldgPct;
            }
            return total / buildings.length;
        }

        function getSubCostForBuilding(buildingId, jobId) {
            const jobSubTotal = appData.subs
                .filter(s => s.jobId === jobId)
                .reduce((sum, s) => sum + (s.billedToDate || 0), 0);
            return distributeJobTotalAcrossBuildings(jobId, jobSubTotal, buildingId);
        }

        function getSubCostForJob(jobId) {
            return appData.subs.filter(s => s.jobId === jobId)
                .reduce((sum, s) => sum + (s.billedToDate || 0), 0);
        }

        function getSubContractForPhase(_phaseId) {
            return 0;
        }

        function getSubContractForBuilding(buildingId, jobId) {
            const jobSubTotal = appData.subs
                .filter(s => s.jobId === jobId)
                .reduce((sum, s) => sum + (s.contractAmt || 0), 0);
            return distributeJobTotalAcrossBuildings(jobId, jobSubTotal, buildingId);
        }

        // Auto-calculate building % complete from its phases, weighted by
        // phaseRevenue() — the SAME revenue basis every money surface uses.
        // (Was weighted by phaseBudget only, which gave 0 weight to legacy
        // phases carrying revenue in asSoldRevenue/asSoldPhaseBudget with
        // phaseBudget=0 — skewing the weighted %.)
        function calcBuildingPctComplete(buildingId, jobId) {
            const bldgPhases = appData.phases.filter(p => p.jobId === jobId && p.buildingId === buildingId);
            if (bldgPhases.length === 0) return 0;
            const totalRev = bldgPhases.reduce((s, p) => s + phaseRevenue(p), 0);
            if (totalRev > 0) {
                return bldgPhases.reduce((s, p) => s + (p.pctComplete || 0) * phaseRevenue(p), 0) / totalRev;
            }
            // Equal weight if no revenue set
            return bldgPhases.reduce((s, p) => s + (p.pctComplete || 0), 0) / bldgPhases.length;
        }

        // Auto-calculate job % complete. Order of preference:
        //   1. Building-weighted (when buildings exist AND phases are linked to them)
        //   2. Phase-weighted directly (when phases exist but aren't all building-linked)
        //   3. Stored job.pctComplete as last-resort fallback
        // The middle case caught a real bug: jobs with buildings + unlinked
        // phases were rolling up to 0%, then overwriting the correct stored
        // value on every Jobs main render because pctCompleteManual was false.
        function calcJobPctComplete(jobId) {
            const buildings = appData.buildings.filter(b => b.jobId === jobId);
            const phases = appData.phases.filter(p => p.jobId === jobId);
            const linkedPhases = phases.filter(p => p.buildingId);

            // 1. Building-weighted, but only if phases are actually attached.
            //    Weight each building by the REVENUE of its own phases (the
            //    basis the building cards + money surfaces use), NOT the raw
            //    building.budget — which is 0 for every 'auto'-derived building
            //    (budget comes from its phases), so the old code silently gave
            //    those buildings zero weight and fell through to a flat average.
            //    Kept node-graph-free (buildingId phase set) so it's correct on
            //    the jobs-list hot path where the graph isn't loaded.
            if (buildings.length > 0 && linkedPhases.length > 0) {
                const bldgData = buildings.map(b => {
                    const revW = appData.phases
                        .filter(p => p.jobId === jobId && p.buildingId === b.id)
                        .reduce((s, p) => s + phaseRevenue(p), 0);
                    return { budget: revW || (b.budget || 0), pct: calcBuildingPctComplete(b.id, jobId) };
                });
                const totalBudget = bldgData.reduce((s, d) => s + d.budget, 0);
                if (totalBudget > 0) {
                    return bldgData.reduce((s, d) => s + d.pct * d.budget, 0) / totalBudget;
                }
                return bldgData.reduce((s, d) => s + d.pct, 0) / bldgData.length;
            }

            // 2. Phase-weighted directly (covers both no-buildings and
            //    buildings-but-phases-not-linked cases) — revenue-weighted.
            if (phases.length > 0) {
                const totalRev = phases.reduce((s, p) => s + phaseRevenue(p), 0);
                if (totalRev > 0) {
                    return phases.reduce((s, p) => s + (p.pctComplete || 0) * phaseRevenue(p), 0) / totalRev;
                }
                return phases.reduce((s, p) => s + (p.pctComplete || 0), 0) / phases.length;
            }

            return appData.jobs.find(j => j.id === jobId)?.pctComplete || 0;
        }

        // Recalculate all sub $ fields on phases and buildings from subs entries
        // Cache keyed by job id; invalidated by a coarse hash of the inputs
        // recalcSubCosts actually reads (phases count + buildings count + subs
        // count + sum of billedToDate). When the hash matches the last seen
        // value for this job, we skip the recompute. This is the hot path
        // inside renderJobsTable — every row in the list triggers a recalc
        // even though most jobs haven't changed since the last render.
        var _subCostHash = {};
        function recalcSubCosts(jobId, opts) {
            opts = opts || {};
            // Build the input hash. Cheap walk through the relevant arrays —
            // O(phases + buildings + subs) but pure-numeric, no allocations
            // beyond the four counters.
            var phaseCount = 0, bldgCount = 0, subCount = 0, billed = 0;
            for (var i = 0; i < appData.phases.length; i++) {
                if (appData.phases[i].jobId === jobId) phaseCount++;
            }
            for (var j = 0; j < appData.buildings.length; j++) {
                if (appData.buildings[j].jobId === jobId) bldgCount++;
            }
            for (var k = 0; k < appData.subs.length; k++) {
                if (appData.subs[k].jobId === jobId) {
                    subCount++;
                    billed += appData.subs[k].billedToDate || 0;
                }
            }
            var hash = phaseCount + '|' + bldgCount + '|' + subCount + '|' + billed;
            if (!opts.force && _subCostHash[jobId] === hash) return;
            _subCostHash[jobId] = hash;

            // Update phases
            appData.phases.filter(p => p.jobId === jobId).forEach(p => {
                p.sub = getSubCostForPhase(p.id);
            });
            // Update buildings
            appData.buildings.filter(b => b.jobId === jobId).forEach(b => {
                b.sub = getSubCostForBuilding(b.id, jobId);
            });
            // Update job-level sub cost
            const job = appData.jobs.find(j => j.id === jobId);
            if (job) {
                // Sub assignments are job-level only — sum every sub's billed-to-date.
                job.sub = appData.subs.filter(s => s.jobId === jobId)
                    .reduce((sum, s) => sum + (s.billedToDate || 0), 0);
            }
        }
        // Expose so save/import paths that DO need fresh numbers can force a
        // recompute. Bulk-save in app.js + the QB-import flow call this.
        window.invalidateSubCostCache = function(jobId) {
            if (jobId) delete _subCostHash[jobId];
            else _subCostHash = {};
        };

        function getJobAccruedCosts(jobId) {
            const job = appData.jobs.find(j => j.id === jobId);
            if (job && job.ngAccruedCosts != null) return job.ngAccruedCosts;

            // Fallback: job-level pct-complete-weighted accrual.
            // Sub assignments are job-level only (the node graph drives
            // per-phase/building distribution), so we just use the
            // job's overall % complete to estimate earned-vs-billed.
            let totalAccrued = 0;
            const jobSubs = appData.subs.filter(s => s.jobId === jobId);
            const jobPct = job ? (job.pctComplete || 0) : 0;
            // A PO is issued TO a sub — its commitment is already accrued by
            // getJobPOAccrued (ordered × pct − billed), which getJobWIP adds
            // alongside this. Counting the sub's own contract again here would
            // double-count that commitment (overstating accrued/projected cost
            // and understating displayed profit). Skip any sub that has a live
            // PO linked by po.sub_id; the sub accrual then covers only subs that
            // are contracted but not yet PO'd.
            const poSubIds = {};
            (appData.jobPurchaseOrders || []).forEach(function (po) {
                if (po.job_id === jobId && po.sub_id
                    && po.status !== 'draft' && po.status !== 'cancelled' && po.status !== 'void') {
                    poSubIds[po.sub_id] = 1;
                }
            });

            jobSubs.forEach(sub => {
                if (poSubIds[sub.id]) return;   // commitment already counted via PO accrual
                const earned = (sub.contractAmt || 0) * (jobPct / 100);
                const accrued = Math.max(0, earned - (sub.billedToDate || 0));
                totalAccrued += accrued;
            });

            return totalAccrued;
        }

        function getJobTotalCost(jobId) {
            // Phase-level costs (tracked per phase)
            let phaseCost = 0;
            appData.phases.filter(p => p.jobId === jobId).forEach(p => {
                phaseCost += (p.materials || 0) + (p.labor || 0) + (p.sub || 0) + (p.equipment || 0);
            });
            // Building-level direct costs (overhead/general NOT covered by phases).
            // Node graph writes costs wired directly to T1 here; costs wired to T2 go to phases.
            let buildingCost = 0;
            const jobBuildings = appData.buildings.filter(b => b.jobId === jobId);
            jobBuildings.forEach(b => {
                buildingCost += (b.materials || 0) + (b.labor || 0) + (b.sub || 0) + (b.equipment || 0);
            });
            // Job-level costs (exclude sub if buildings exist — already distributed)
            const job = appData.jobs.find(j => j.id === jobId);
            let jobCost = 0;
            if (job) {
                const jobSub = (jobBuildings.length > 0) ? 0 : (job.sub || 0);
                jobCost = (job.materials || 0) + (job.labor || 0) + jobSub + (job.equipment || 0) + (job.generalConditions || 0);
            }
            return { phaseCost, buildingCost, jobCost, total: phaseCost + buildingCost + jobCost };
        }

        // Sub/PO bills the sub has invoiced you (the unified job_vendor_bills AP
        // store) are INCURRED cost — they roll into ACTUAL. Excludes draft/void/
        // cancelled/rejected (not real invoices yet). Billed is already netted out
        // of accrued (getJobPOAccrued = earned − billed), so a billed dollar moves
        // from accrued → actual, never sits in both.
        function getJobBilledCost(jobId) {
            var DEAD = { draft: 1, void: 1, cancelled: 1, canceled: 1, rejected: 1 };
            return (appData.jobVendorBills || []).reduce(function(s, b) {
                if (!b || (b.job_id !== jobId && b.jobId !== jobId)) return s;
                if (DEAD[b.status]) return s;
                return s + (Number(b.amount) || 0);
            }, 0);
        }
        window.getJobBilledCost = getJobBilledCost;

        // ==================== WIP CALCULATIONS ====================
        // Sell price of ONE change order. There is no flat co.income field —
        // money lives in c.lines run through the shared pricing pipeline
        // (markup -> optional target margin -> fees + tax), exactly as the CO
        // editor totals it. Named + exported so any surface needing a per-CO
        // amount (the Site Plan's contract allocation board) uses this identical
        // math instead of re-summing lines and drifting.
        function coSellAmount(c) {
            const lines = Array.isArray(c && c.lines) ? c.lines : [];
            if (!window.p86Pricing || !lines.length) return 0;
            const per = window.p86Pricing.computeForLines(c, lines);
            let markedUp = per.markedUp;
            if (window.p86Pricing.targetMarginActive(c)) {
                markedUp = window.p86Pricing.applyTargetMargin(per.subtotal, c);
            }
            return window.p86Pricing.applyFeesAndTax(markedUp, c).total;
        }
        window.coSellAmount = coSellAmount;
        function getJobCOTotals(jobId) {
            // Change orders are server-backed and live in appData.jobChangeOrders
            // (loaded per-job on demand + boot-loaded in app.js). A CO adds to the
            // contract once it's approved or applied; its income/cost come from its
            // line items via the shared pricing pipeline — there is NO flat
            // co.income field, money lives in c.lines + fee/tax/markup, exactly
            // like the CO editor's own total (coTotal below). The legacy
            // appData.changeOrders store is a dead localStorage relic kept only as
            // a fallback for any pre-server COs.
            const server = (appData.jobChangeOrders || []).filter(c =>
                c && c.job_id === jobId && (c.status === 'approved' || c.status === 'applied'));
            if (server.length && window.p86Pricing) {
                let income = 0, costs = 0, unlinkedIncome = 0;
                server.forEach(c => {
                    const lines = Array.isArray(c.lines) ? c.lines : [];
                    const per = window.p86Pricing.computeForLines(c, lines);
                    const sell = coSellAmount(c);
                    income += sell;
                    costs += per.subtotal; // raw line cost (before markup/fee/tax)
                    // A CO linked to a graph node already has its lines folded into
                    // that node's revenue (ngRevenueEarned). Only UNLINKED COs need
                    // their earned share added to revenueEarned downstream — tracking
                    // that separately here prevents double-counting linked ones.
                    if (!c.linked_node_id) unlinkedIncome += sell;
                });
                return { income, costs, unlinkedIncome, count: server.length };
            }
            // Legacy fallback: old localStorage COs carried flat income/cost fields
            // and were never graph-linked, so all of it is "unlinked".
            const legacy = (appData.changeOrders || []).filter(co => co.jobId === jobId);
            const legacyIncome = legacy.reduce((sum, co) => sum + (co.income || 0), 0);
            return {
                income: legacyIncome,
                costs: legacy.reduce((sum, co) => sum + (co.estimatedCosts || 0), 0),
                unlinkedIncome: legacyIncome,
                count: legacy.length
            };
        }

        function getJobWIP(jobId) {
            const job = appData.jobs.find(j => j.id === jobId);
            if (!job) return {};
            const co = getJobCOTotals(jobId);
            // QuickBooks imported cost total for this job (server-hydrated into
            // appData.qbCostLines). QB is the cost source of truth until costs are
            // wired to nodes, so it flows into actual cost. When the node graph has
            // computed, its ngActualCosts ALREADY folds this QB total in (see
            // nodegraph/ui.js) — use it as-is. With no graph yet, add QB onto the
            // manual cost total here. Counted exactly once either way (the engine
            // no longer folds QB per-node).
            // ACTUAL cost counts ONLY QuickBooks lines LINKED to a cost node
            // (linked_node_id). Unlinked QB is excluded entirely — John's rule:
            // "if a cost from QuickBooks isn't linked, don't show it in actual
            // costs." Link a cost to a node (Site Map / cost inbox) to make it
            // count. qbActualCosts/qbCostLineCount reflect the LINKED set only.
            let qbActualCosts = 0, qbCostLineCount = 0, qbCostsAsOf = null;
            try {
                const qbLines = (window.appData && Array.isArray(appData.qbCostLines))
                    ? appData.qbCostLines.filter(l => (l.job_id || l.jobId) === jobId
                        && (l.linked_node_id != null || l.linkedNodeId != null)) : [];
                qbCostLineCount = qbLines.length;
                qbLines.forEach(l => {
                    qbActualCosts += Number(l.amount || 0);
                    const d = l.report_date || l.reportDate;
                    if (d && (!qbCostsAsOf || String(d) > String(qbCostsAsOf))) qbCostsAsOf = String(d).slice(0, 10);
                });
            } catch (e) {}
            // Graph's MANUAL/wired cost only. ngActualCosts explicitly EXCLUDES QB
            // — the ui.js assembly is `getOutput(wipNode,1) + jobMat/Lab/Equip/GC`
            // and cost-node getActual/getOutput return `items || n.value` (no QB);
            // "QB is folded in by getJobWIP, NOT here." Falls back to the phase/
            // building manual total before the graph has computed.
            const baseActualCosts = (job.ngActualCosts != null) ? job.ngActualCosts : getJobTotalCost(jobId).total;
            // ACTUAL = manual/wired graph cost + every LINKED QB line for the job.
            // qbActualCosts is summed at the JOB level (all lines with a
            // linked_node_id, above), so linked QB totals no matter which tier the
            // line is linked to — job, building, phase, or a specific cost node —
            // and it's added exactly once regardless of graph topology. Unlinked QB
            // is excluded (John's rule). Stateless — correct on the jobs list +
            // unopened jobs. (No double-count: ngActualCosts carries no QB.)
            // + sub/PO bills (job_vendor_bills): what the sub has BILLED you is
            // incurred cost, so it rolls into ACTUAL — not left stranded once it
            // clears accrued (getJobPOAccrued nets billed out, so no double-count).
            // No QB link on bills, so a cost entered as BOTH a P86 bill and a linked
            // QB line would count twice — subs bill via Bills, QB carries materials,
            // so they don't overlap in practice.
            const billedCost = (typeof getJobBilledCost === 'function') ? getJobBilledCost(jobId) : 0;
            const actualCosts = baseActualCosts + qbActualCosts + billedCost;
            const contractIncome = job.contractAmount || 0;
            const estimatedCosts = job.estimatedCosts || 0;
            const totalIncome = contractIncome + co.income;
            const totalEstCosts = estimatedCosts + co.costs;
            const revisedCostChanges = job.revisedCostChanges || 0;
            const revisedEstCosts = totalEstCosts + revisedCostChanges;
            const asSoldProfit = contractIncome - estimatedCosts;
            const asSoldMargin = contractIncome > 0 ? (asSoldProfit / contractIncome * 100) : 0;
            // "Revised" profit/margin = the as-sold + change-orders plan
            // (income vs revised cost). Distinct from JTD.
            const revisedProfit = totalIncome - revisedEstCosts;
            const revisedMargin = totalIncome > 0 ? (revisedProfit / totalIncome * 100) : 0;
            const pctComplete = job.pctComplete || 0;
            // Prefer the engine's computed values when the node graph has
            // already pushed them — they use unrounded weighted pct and
            // match the watch-node displays. Fall back to local formula
            // when the graph hasn't run yet (job has no graph state).
            // Earned share of change-order income. The node graph's
            // ngRevenueEarned only knows about GRAPH revenue (the base contract),
            // so unlinked-CO income never reaches it — add its pct-complete share
            // here so an applied CO flows through to Revenue Earned → Gross Profit
            // → Margin, not just the Total Income headline. The no-graph fallback
            // already folds ALL CO income in via totalIncome, so it needs nothing.
            const coEarned = (co.unlinkedIncome || 0) * (pctComplete / 100);
            const revenueEarned = (job.ngRevenueEarned != null)
                ? job.ngRevenueEarned + coEarned
                : totalIncome * (pctComplete / 100);
            // Recompute JTD from the QB-inclusive actual cost. Do NOT prefer the
            // engine's ngJtdProfit/ngJtdMargin — those are computed from the graph's
            // MANUAL cost only (QB excluded), so they'd overstate profit. Revenue
            // still uses the engine's weighted-pct value (revenueEarned above).
            const jtdProfit = revenueEarned - actualCosts;
            const jtdMargin = revenueEarned > 0 ? (jtdProfit / revenueEarned * 100) : 0;
            const invoiced = job.invoicedToDate || 0;
            const unbilled = revenueEarned - invoiced;
            const backlog = (job.ngBacklog != null)
                ? job.ngBacklog
                : totalIncome - revenueEarned;
            const remainingCosts = revisedEstCosts - actualCosts;
            // Accrued (committed) cost = sub earned-but-unbilled + open PO
            // commitments (ordered − billed, via getJobPOAccrued). Once a sub BILLS,
            // that dollar leaves accrued and lands in ACTUAL (getJobBilledCost, folded
            // into actualCosts above) — the two never overlap. Projected = actual +
            // accrued = the full committed cost.
            const poAccrued = (typeof getJobPOAccrued === 'function') ? (getJobPOAccrued(jobId).total || 0) : 0;
            const accruedCosts = getJobAccruedCosts(jobId) + poAccrued;
            const projectedCost = actualCosts + accruedCosts;
            const projectedProfit = totalIncome - projectedCost;
            // Headline Profit/Margin for the job card + Jobs List: use job-to-date
            // once there's REAL progress (actual costs logged OR revenue earned);
            // otherwise fall back to the AS-SOLD projection (contract − estimated
            // cost, incl. COs) so a freshly estimate-linked job shows its expected
            // gross profit instead of $0.
            //   Prior bug: gated on `job.ngJtdProfit != null`, but Renovation jobs
            //   get a Site-Plan node graph that pushes ngJtdProfit = 0 at 0% done —
            //   a non-null zero — so every Renovation job showed $0 while Service &
            //   Repair jobs (no graph → ngJtdProfit null) correctly showed as-sold.
            //   Basing it on genuine activity fixes the job-type split.
            const hasActuals = actualCosts > 0 || revenueEarned > 0;
            // Headline profit/margin roll ACCRUED (committed) cost in alongside
            // actual — job-to-date, net of commitments (John's call). jtdProfit /
            // jtdMargin above stay PURE (revenue − actual) for the WIP report + the
            // job-audit margin-drift rule; only the display figures net out accrued.
            const displayProfit = hasActuals ? (jtdProfit - accruedCosts) : revisedProfit;
            const displayMargin = hasActuals ? (revenueEarned > 0 ? (displayProfit / revenueEarned * 100) : 0) : revisedMargin;
            // qbActualCosts / qbCostLineCount / qbCostsAsOf computed above and now
            // folded into actualCosts; still returned as their own figures for the
            // "QB actuals as of <date>" chip + mismatch flag on the overview.
            return {
                contractIncome, estimatedCosts, coIncome: co.income, coCosts: co.costs,
                totalIncome, totalEstCosts, revisedCostChanges, revisedEstCosts,
                asSoldProfit, asSoldMargin, revisedProfit, revisedMargin,
                pctComplete, revenueEarned, actualCosts, jtdProfit, jtdMargin,
                displayProfit, displayMargin,
                qbActualCosts, qbCostLineCount, qbCostsAsOf,
                invoiced, unbilled, backlog, remainingCosts,
                accruedCosts, poAccrued, billedCost, projectedCost, projectedProfit
            };
        }
        // Exposed for js/job-audit.js (R8 margin-drift + R10 underbilled rules).
        window.getJobWIP = getJobWIP;

        function renderWipTab(jobId) {
            const job = appData.jobs.find(j => j.id === jobId);
            if (!job) return;
            const w = getJobWIP(jobId);
            // WIP inputs (% complete, invoiced-to-date, revised cost changes, notes) are
            // now edited on the working Site Map / node graph — this tab is a read-only
            // report. Only the calculated readouts below are populated.

            document.getElementById('wip-contract-income').textContent = formatCurrency(w.contractIncome);
            document.getElementById('wip-co-income').textContent = formatCurrency(w.coIncome);
            document.getElementById('wip-total-income').textContent = formatCurrency(w.totalIncome);
            document.getElementById('wip-est-costs').textContent = formatCurrency(w.estimatedCosts);
            document.getElementById('wip-co-costs').textContent = formatCurrency(w.coCosts);
            document.getElementById('wip-revised-changes').textContent = formatCurrency(w.revisedCostChanges);
            document.getElementById('wip-total-est-costs').textContent = formatCurrency(w.revisedEstCosts);
            document.getElementById('wip-assold-profit').textContent = formatCurrency(w.asSoldProfit);
            document.getElementById('wip-assold-profit').style.color = w.asSoldProfit >= 0 ? 'var(--green)' : 'var(--red)';
            document.getElementById('wip-assold-margin').textContent = w.asSoldMargin.toFixed(1) + '%';
            document.getElementById('wip-revised-profit').textContent = formatCurrency(w.revisedProfit);
            document.getElementById('wip-revised-profit').style.color = w.revisedProfit >= 0 ? 'var(--green)' : 'var(--red)';
            document.getElementById('wip-revised-margin').textContent = w.revisedMargin.toFixed(1) + '%';
            document.getElementById('wip-pct-complete').textContent = w.pctComplete.toFixed(1) + '%';
            document.getElementById('wip-revenue-earned').textContent = formatCurrency(w.revenueEarned);
            document.getElementById('wip-jtd-profit').textContent = formatCurrency(w.jtdProfit);
            document.getElementById('wip-jtd-profit').style.color = w.jtdProfit >= 0 ? 'var(--green)' : 'var(--red)';
            document.getElementById('wip-jtd-margin').textContent = w.jtdMargin.toFixed(1) + '%';
            document.getElementById('wip-invoiced').textContent = formatCurrency(w.invoiced);
            document.getElementById('wip-unbilled').textContent = formatCurrency(w.unbilled);
            document.getElementById('wip-unbilled').style.color = w.unbilled >= 0 ? 'var(--yellow)' : 'var(--red)';
            document.getElementById('wip-backlog').textContent = formatCurrency(w.backlog);
            document.getElementById('wip-actual-costs').textContent = formatCurrency(w.actualCosts);
            document.getElementById('wip-revised-est-costs2').textContent = formatCurrency(w.revisedEstCosts);
            document.getElementById('wip-remaining-costs').textContent = formatCurrency(w.remainingCosts);
            document.getElementById('wip-remaining-costs').style.color = w.remainingCosts >= 0 ? 'var(--text)' : 'var(--red)';

            // Captured Costs (field receipts) — read-only rollup by cost code from
            // the Cost Inbox. Appended once to the WIP pane, re-mounted each render.
            try {
                var wipPane = document.getElementById('job-wip-report');
                if (wipPane && window.p86CostInbox && window.p86CostInbox.mountRollup) {
                    var card = document.getElementById('wip-captured-costs-card');
                    if (!card) {
                        card = document.createElement('div');
                        card.id = 'wip-captured-costs-card';
                        card.className = 'card';
                        card.style.marginTop = '10px';
                        card.innerHTML = '<div id="wip-captured-costs-inner"></div>';
                        wipPane.appendChild(card);
                    }
                    window.p86CostInbox.mountRollup(document.getElementById('wip-captured-costs-inner'), { entityType: 'job', entityId: jobId });
                }
            } catch (e) { /* rollup is best-effort */ }
        }

        // The WIP Report Inputs card + its saveWipInputs()/distributeJobPctComplete()
        // helpers were removed — % complete, invoiced-to-date, and revised cost changes
        // are now edited on the working Site Map / node graph, which distributes % down
        // to buildings/phases itself. The WIP tab is a read-only report.

        // ==================== CHANGE ORDERS ====================
        // ── Phase 4: server-backed CO list on the job detail ──
        // Fetches /api/jobs/:jobId/change-orders and caches the response
        // into appData.jobChangeOrders. Refreshes the rendered list
        // when complete. Safe to call multiple times; in-flight fetches
        // are tracked per-job so re-opening doesn't dup-fetch.
        var _coFetchInflight = {};
        function loadChangeOrdersForJob(jobId) {
            if (!jobId || !window.p86Api || !window.p86Api.changeOrders) return Promise.resolve([]);
            if (_coFetchInflight[jobId]) return _coFetchInflight[jobId];
            _coFetchInflight[jobId] = window.p86Api.changeOrders.listForJob(jobId)
                .then(function(r) {
                    var list = (r && r.change_orders) || [];
                    // Replace this job's rows in the cache.
                    if (!Array.isArray(appData.jobChangeOrders)) appData.jobChangeOrders = [];
                    appData.jobChangeOrders = appData.jobChangeOrders
                        .filter(function(c) { return c.job_id !== jobId; })
                        .concat(list);
                    delete _coFetchInflight[jobId];
                    return list;
                })
                .catch(function(e) {
                    delete _coFetchInflight[jobId];
                    console.warn('loadChangeOrdersForJob failed:', e);
                    return [];
                });
            return _coFetchInflight[jobId];
        }
        window.loadChangeOrdersForJob = loadChangeOrdersForJob;

        // Render the server-side CO list into a job's overview panel.
        // Mounts an inline-styled section with a "+ New Change Order"
        // button, a count badge, and a clickable row per CO. Re-paints
        // after each loadChangeOrdersForJob.
        function renderJobChangeOrdersInto(container, jobId, mountId) {
            var mount = document.createElement('div');
            // Distinct id per surface (overview vs the CO subtab) so the
            // same renderer can mount in both without colliding ids.
            mount.id = mountId || 'job-overview-change-orders';
            mount.style.cssText = 'margin-top:14px;';
            container.appendChild(mount);
            paintJobChangeOrdersInto(mount, jobId);
            // Kick off a fresh fetch so the list updates after first
            // load. If the cache already has rows for this job, the
            // first paint above already shows them.
            loadChangeOrdersForJob(jobId).then(function() {
                paintJobChangeOrdersInto(mount, jobId);
            });
        }
        function paintJobChangeOrdersInto(mount, jobId) {
            if (!mount) return;
            var rows = (appData.jobChangeOrders || []).filter(function(c) { return c.job_id === jobId; });
            // Sort newest first so freshly-created COs are visible
            // without scrolling on a long job.
            rows.sort(function(a, b) {
                return new Date(b.updated_at || 0) - new Date(a.updated_at || 0);
            });
            function statusBadge(s) {
                var color = s === 'approved' ? 'var(--green,#34d399)'
                          : s === 'applied' ? 'var(--accent,#4f8cff)'
                          : '#cbd5e1';
                var bg = s === 'approved' ? 'rgba(52,211,153,0.12)'
                       : s === 'applied' ? 'rgba(79,140,255,0.12)'
                       : 'rgba(148,163,184,0.12)';
                var label = s === 'draft' ? 'Draft' : s === 'approved' ? 'Approved' : 'Applied';
                return '<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700;letter-spacing:0.4px;text-transform:uppercase;color:' + color + ';background:' + bg + ';">' + label + '</span>';
            }
            function coTotal(c) {
                // Lines live in the data blob (spread on top of the row by
                // the server's shapeRow). Use the shared pricing pipeline
                // so totals match what the editor shows.
                if (!window.p86Pricing) return 0;
                var lines = Array.isArray(c.lines) ? c.lines : [];
                var per = window.p86Pricing.computeForLines(c, lines);
                var markedUp = per.markedUp;
                if (window.p86Pricing.targetMarginActive(c)) {
                    markedUp = window.p86Pricing.applyTargetMargin(per.subtotal, c);
                }
                return window.p86Pricing.applyFeesAndTax(markedUp, c).total;
            }
            var bodyHTML;
            if (!rows.length) {
                bodyHTML =
                    '<div style="padding:20px;border:1px dashed var(--border,#333);border-radius:10px;text-align:center;color:var(--text-dim,#888);font-size:12px;">' +
                        'No change orders yet. Click <strong>+ New Change Order</strong> to start one.' +
                    '</div>';
            } else {
                var rowsHTML = rows.map(function(c) {
                    var total = coTotal(c);
                    return '<tr class="overview-row" style="cursor:pointer;border-bottom:1px solid var(--overlay-light,rgba(255,255,255,0.04));" data-co-open="' + escapeHTML(c.id) + '" title="Click to open">' +
                        '<td style="white-space:nowrap;padding:8px 10px;"><strong style="color:var(--text,#fff);font-size:13px;">' + escapeHTML(c.co_number || 'CO') + '</strong></td>' +
                        '<td style="padding:8px 10px;font-size:12.5px;color:var(--text,#fff);">' + escapeHTML(c.title || '(untitled)') + '</td>' +
                        '<td style="white-space:nowrap;padding:8px 10px;">' + statusBadge(c.status || 'draft') + '</td>' +
                        '<td class="num" style="text-align:right;white-space:nowrap;padding:8px 10px;font-family:\'SF Mono\',monospace;font-size:13px;color:var(--green,#34d399);font-weight:600;">' + formatCurrency(total) + '</td>' +
                        '<td style="white-space:nowrap;padding:8px 10px;font-size:11px;color:var(--text-dim,#888);">' + (c.linked_node_id ? '⛓ Linked' : '—') + '</td>' +
                    '</tr>';
                }).join('');
                bodyHTML =
                    '<div style="border:1px solid var(--border,#333);border-radius:10px;overflow-x:auto;background:var(--card-bg,#141419);">' +
                        '<table style="width:100%;border-collapse:collapse;">' +
                            '<thead style="background:var(--overlay-light,rgba(255,255,255,0.02));border-bottom:1px solid var(--border,#333);"><tr>' +
                                thCell('CO #', 'left') +
                                thCell('Title', 'left') +
                                thCell('Status', 'left') +
                                thCell('Total', 'right') +
                                thCell('Graph', 'left') +
                            '</tr></thead>' +
                            '<tbody>' + rowsHTML + '</tbody>' +
                        '</table>' +
                    '</div>';
            }
            mount.innerHTML =
                '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">' +
                    '<h3 style="font-size:13px;margin:0;">&#x1F4DD; Change Orders (' + rows.length + ')</h3>' +
                    '<button class="ee-btn primary" data-co-new="' + escapeHTML(jobId) + '" style="font-size:12px;">+ New Change Order</button>' +
                '</div>' +
                bodyHTML;
            // Wire row clicks → open editor
            mount.querySelectorAll('[data-co-open]').forEach(function(tr) {
                tr.addEventListener('click', function() {
                    var id = tr.getAttribute('data-co-open');
                    if (window.p86ChangeOrders && window.p86ChangeOrders.open) {
                        window.p86ChangeOrders.open(id);
                    }
                });
            });
            // Wire "+ New" → create draft + open editor. The editor
            // refreshes its in-memory record from the server, so the
            // list re-paint here will pick up the new row.
            var newBtn = mount.querySelector('[data-co-new]');
            if (newBtn) newBtn.addEventListener('click', function() {
                if (window.p86ChangeOrders && window.p86ChangeOrders.openNew) {
                    window.p86ChangeOrders.openNew(jobId);
                    // After the editor closes the user may have created
                    // a row. Best-effort refresh after a short delay so
                    // the list shows it. The editor doesn't currently
                    // emit a close-event, so this is the simplest hook.
                    setTimeout(function() {
                        loadChangeOrdersForJob(jobId).then(function() {
                            paintJobChangeOrdersInto(mount, jobId);
                        });
                    }, 500);
                }
            });
        }

        // ── CO Allocation Helpers ──
        function getCOAllocations(co) {
            if (co.allocations) return co.allocations;
            if (co.buildingAllocations && co.buildingAllocations.length > 0) {
                return co.buildingAllocations.map(a => ({ buildingId: a.buildingId, income: a.amount || 0, costs: 0 }));
            }
            return [];
        }

        function reverseCOBudgetImpact(co) {
            var allocs = getCOAllocations(co);
            var level = co.allocationType || (allocs.length > 0 ? 'building' : 'job');
            allocs.forEach(function(alloc) {
                if (level === 'phase' && alloc.phaseId) {
                    var phase = appData.phases.find(p => p.id === alloc.phaseId);
                    if (phase) phase.phaseBudget = (phase.phaseBudget || 0) - (alloc.income || 0);
                }
                if ((level === 'building' || level === 'phase') && alloc.buildingId) {
                    var bldg = appData.buildings.find(b => b.id === alloc.buildingId);
                    if (bldg) bldg.budget = (bldg.budget || 0) - (alloc.income || 0);
                }
            });
        }

        function applyCOBudgetImpact(co) {
            var allocs = getCOAllocations(co);
            var level = co.allocationType || 'job';
            allocs.forEach(function(alloc) {
                if (level === 'phase' && alloc.phaseId) {
                    var phase = appData.phases.find(p => p.id === alloc.phaseId);
                    if (phase) phase.phaseBudget = (phase.phaseBudget || 0) + (alloc.income || 0);
                }
                if ((level === 'building' || level === 'phase') && alloc.buildingId) {
                    var bldg = appData.buildings.find(b => b.id === alloc.buildingId);
                    if (bldg) bldg.budget = (bldg.budget || 0) + (alloc.income || 0);
                }
            });
        }

        // ── CO Modal Functions ──
        function openAddChangeOrderModal() {
            // Route to the modern server-backed CO editor (same one the CO
            // list's "+ New Change Order" uses). The legacy inline addCOModal
            // below wrote to appData.changeOrders — a dead store the current
            // list (appData.jobChangeOrders) never reads, so those COs were
            // invisible. Kept only as a defensive fallback if the editor
            // module hasn't loaded.
            if (window.p86ChangeOrders && typeof window.p86ChangeOrders.openNew === 'function') {
                window.p86ChangeOrders.openNew(appState.currentJobId);
                return;
            }
            document.getElementById('coModalHeader').textContent = 'Add Change Order';
            document.getElementById('coSaveBtn').innerHTML = '&#x1F4DD; Add Change Order';
            document.getElementById('coNumber').value = '';
            document.getElementById('coDate').value = new Date().toISOString().split('T')[0];
            document.getElementById('coDescription').value = '';
            document.getElementById('coIncome').value = '';
            document.getElementById('coCosts').value = '';
            document.getElementById('coNotes').value = '';
            appState.editCOId = null;
            openModal('addCOModal');
        }

        function saveCO() {
            const desc = document.getElementById('coDescription').value.trim();
            if (!desc) { alert('Enter a description'); return; }
            const coData = {
                jobId: appState.currentJobId,
                coNumber: document.getElementById('coNumber').value.trim(),
                description: desc,
                income: parseFloat(document.getElementById('coIncome').value) || 0,
                estimatedCosts: parseFloat(document.getElementById('coCosts').value) || 0,
                date: document.getElementById('coDate').value,
                notes: document.getElementById('coNotes').value.trim(),
                allocationType: 'job',
                allocations: []
            };
            // Reverse old budget impact when editing
            if (appState.editCOId) {
                var oldCO = appData.changeOrders.find(co => co.id === appState.editCOId);
                if (oldCO) reverseCOBudgetImpact(oldCO);
                const idx = appData.changeOrders.findIndex(co => co.id === appState.editCOId);
                if (idx >= 0) Object.assign(appData.changeOrders[idx], coData);
            } else {
                coData.id = 'co' + Date.now();
                appData.changeOrders.push(coData);
            }
            // Apply new budget impact
            applyCOBudgetImpact(coData);
            saveData();
            closeModal('addCOModal');
            renderJobDetail(appState.currentJobId);
        }

        function editCO(coId) {
            const co = appData.changeOrders.find(c => c.id === coId);
            if (!co) return;
            appState.editCOId = coId;
            document.getElementById('coModalHeader').textContent = 'Edit Change Order';
            document.getElementById('coSaveBtn').innerHTML = '&#x1F4BE; Update Change Order';
            document.getElementById('coNumber').value = co.coNumber || '';
            document.getElementById('coDate').value = co.date || '';
            document.getElementById('coDescription').value = co.description || '';
            document.getElementById('coIncome').value = co.income || '';
            document.getElementById('coCosts').value = co.estimatedCosts || '';
            document.getElementById('coNotes').value = co.notes || '';
            openModal('addCOModal');
        }

        function deleteCO(coId) {
            _confirmDelete('change order').then(function(ok) {
                if (!ok) return;
                var co = appData.changeOrders.find(c => c.id === coId);
                if (co) reverseCOBudgetImpact(co);
                appData.changeOrders = appData.changeOrders.filter(c => c.id !== coId);
                saveData();
                renderJobDetail(appState.currentJobId);
            });
        }

        function renderChangeOrders(jobId) {
            // Repointed to the server-backed job_change_orders entity (was
            // the legacy appData.changeOrders / #co-table). Renders the
            // same list the Jobs hub shows, filtered to this job; rows open
            // the dedicated CO editor (window.p86ChangeOrders).
            var coHost = document.getElementById('job-changeorders');
            if (!coHost) return;
            coHost.innerHTML = '';
            renderJobChangeOrdersInto(coHost, jobId, 'job-subtab-change-orders');
        }

        // ==================== PURCHASE ORDERS ====================
        // ── Server-backed PO list on the job detail (mirrors the CO flow) ──
        // The job Purchase Orders subtab renders the new job_purchase_orders
        // entity (p86Api.purchaseOrders) — the same records the Jobs hub
        // shows — NOT the legacy appData.purchaseOrders. Rows open the
        // dedicated PO editor (window.p86PurchaseOrders).
        var _poFetchInflight = {};
        // Vendor Bills (Accounts Payable) store — the unified source the PO
        // %-billed rollup reads (Bills S3). Mirrors the jobPurchaseOrders store:
        // boot-loaded whole (appData.jobVendorBills + appData._billsAllLoaded)
        // and refreshable per-job. poRowBilled sums from here; it falls back to
        // the PO's frozen embedded data.bills[] only until the store loads for
        // that job (the migration copied those into the table, so no drift).
        var _billFetchInflight = {};
        var _billsLoadedJobs = Object.create(null);
        function loadBillsForJob(jobId) {
            if (!jobId || !window.p86Api || !window.p86Api.bills) return Promise.resolve([]);
            if (_billFetchInflight[jobId]) return _billFetchInflight[jobId];
            _billFetchInflight[jobId] = window.p86Api.bills.listForJob(jobId)
                .then(function(r) {
                    var list = (r && r.bills) || [];
                    if (!Array.isArray(appData.jobVendorBills)) appData.jobVendorBills = [];
                    appData.jobVendorBills = appData.jobVendorBills
                        .filter(function(b) { return b.job_id !== jobId; })
                        .concat(list);
                    _billsLoadedJobs[jobId] = true;
                    delete _billFetchInflight[jobId];
                    return list;
                })
                .catch(function(e) {
                    delete _billFetchInflight[jobId];
                    console.warn('loadBillsForJob failed:', e);
                    return [];
                });
            return _billFetchInflight[jobId];
        }
        window.loadBillsForJob = loadBillsForJob;
        // Boot hydration for the whole-org bills snapshot (called once from
        // app.js). MERGES rather than blind-replaces: a job whose bills a fast
        // per-job loadBillsForJob already pulled (its uncapped /jobs/:id/bills
        // fetch is authoritative) is preserved, not clobbered by a possibly-
        // truncated boot snapshot. ok=false (fetch failed OR hit the server row
        // cap) leaves _billsAllLoaded false so poRowBilled falls back to the
        // embedded (migrated) data.bills[] for jobs not individually loaded —
        // never silently zeroing billed and over-stating accrued.
        window.hydrateBillsStore = function(bills, ok) {
            bills = Array.isArray(bills) ? bills : [];
            var existing = Array.isArray(appData.jobVendorBills) ? appData.jobVendorBills : [];
            var kept = existing.filter(function(b) { return _billsLoadedJobs[b.job_id]; });
            var incoming = bills.filter(function(b) { return !_billsLoadedJobs[b.job_id]; });
            appData.jobVendorBills = kept.concat(incoming);
            appData._billsAllLoaded = !!ok;
        };
        function loadPurchaseOrdersForJob(jobId) {
            if (!jobId || !window.p86Api || !window.p86Api.purchaseOrders) return Promise.resolve([]);
            if (_poFetchInflight[jobId]) return _poFetchInflight[jobId];
            _poFetchInflight[jobId] = window.p86Api.purchaseOrders.listForJob(jobId)
                .then(function(r) {
                    var list = (r && r.purchase_orders) || [];
                    if (!Array.isArray(appData.jobPurchaseOrders)) appData.jobPurchaseOrders = [];
                    appData.jobPurchaseOrders = appData.jobPurchaseOrders
                        .filter(function(p) { return p.job_id !== jobId; })
                        .concat(list);
                    delete _poFetchInflight[jobId];
                    return list;
                })
                .catch(function(e) {
                    delete _poFetchInflight[jobId];
                    console.warn('loadPurchaseOrdersForJob failed:', e);
                    return [];
                });
            return _poFetchInflight[jobId];
        }
        window.loadPurchaseOrdersForJob = loadPurchaseOrdersForJob;

        // PO total from its line items — mirrors the Jobs hub computation
        // (qty * unitCost, skipping section headers) so the number matches
        // the hub + editor. Billed = sum of recorded bills.
        function poRowTotal(po) {
            return (Array.isArray(po && po.lines) ? po.lines : []).reduce(function(s, l) {
                if (!l || l.section === '__section_header__') return s;
                return s + (parseFloat(l.qty) || 0) * (parseFloat(l.unitCost) || 0);
            }, 0);
        }
        function poRowBilled(po) {
            if (!po) return 0;
            // Unified store (Bills S3): sum the job_vendor_bills rows linked to
            // this PO, excluding void. Read the store once it's loaded (boot-load
            // set _billsAllLoaded, or a per-job loadBillsForJob). Until then fall
            // back to the PO's frozen embedded data.bills[] — the migration copied
            // those into the table, so the number is identical, just pre-fetch.
            var loaded = appData._billsAllLoaded || _billsLoadedJobs[po.job_id];
            if (loaded && Array.isArray(appData.jobVendorBills)) {
                return appData.jobVendorBills.reduce(function(s, b) {
                    if (b.po_id !== po.id || b.status === 'void') return s;
                    return s + (parseFloat(b.amount) || 0);
                }, 0);
            }
            return (Array.isArray(po.bills) ? po.bills : []).reduce(function(s, b) {
                return s + (parseFloat(b.amount) || 0);
            }, 0);
        }

        // Open Purchase Order commitments = ACCRUED cost (John's model: accrued =
        // the EARNED share of the PO by progress − what the sub has billed. Earned =
        // ordered × the job's overall % complete; accrued = max(0, earned − billed).
        // So a PO on a 0%-done job accrues nothing, and at 100% it's ordered −
        // billed. As the sub bills / gets paid, that amount lands in ACTUAL via the
        // QB import (billed rises → accrued falls) — never double-counted.
        // Attributed to the phase whose name appears in the PO title/line
        // description (else job-level). Reads appData.jobPurchaseOrders, which loads
        // on-demand — returns 0 until the overview's PO section fetches.
        function getJobPOAccrued(jobId) {
            var job = (appData.jobs || []).find(function(j) { return j.id === jobId; });
            var jobPct = job ? (Number(job.pctComplete) || 0) : 0;
            var pos = (appData.jobPurchaseOrders || []).filter(function(p) {
                return p.job_id === jobId && p.status !== 'draft' && p.status !== 'cancelled' && p.status !== 'void';
            });
            var phaseNames = [];
            (appData.phases || []).forEach(function(p) { if (p.jobId === jobId) { var n = (p.phase || '').trim(); if (n && phaseNames.indexOf(n) === -1) phaseNames.push(n); } });
            var total = 0, byPhase = {};
            pos.forEach(function(po) {
                // Earned by progress (ordered × job % complete), net of what the
                // sub has already billed. Only the still-unbilled earned amount is
                // accrued (unbilled cost you've incurred but QB hasn't caught yet).
                var earned = poRowTotal(po) * (jobPct / 100);
                var open = Math.max(0, earned - poRowBilled(po));
                if (open <= 0) return;
                total += open;
                var matched = null;
                // Explicit phase link (PO editor's Phase dropdown) wins; else fall
                // back to matching the PO title/line text against a phase name.
                if (po.phaseName && phaseNames.indexOf(po.phaseName) >= 0) {
                    matched = po.phaseName;
                } else {
                    var hay = ((po.title || '') + ' ' + (po.lines || []).map(function(l) { return l.description || ''; }).join(' ')).toLowerCase();
                    phaseNames.forEach(function(n) { if (!matched && hay.indexOf(n.toLowerCase()) >= 0) matched = n; });
                }
                var key = matched || '__job__';
                byPhase[key] = (byPhase[key] || 0) + open;
            });
            return { total: total, byPhase: byPhase };
        }
        window.getJobPOAccrued = getJobPOAccrued;

        function renderJobPurchaseOrdersInto(container, jobId, mountId) {
            var mount = document.createElement('div');
            mount.id = mountId || 'job-overview-purchase-orders';
            mount.style.cssText = 'margin-top:4px;';
            container.appendChild(mount);
            paintJobPurchaseOrdersInto(mount, jobId);
            // Load POs + their bills together so the accrued tile nets out
            // billed against earned on first paint (billed comes from the
            // unified bills store — Bills S3).
            Promise.all([loadPurchaseOrdersForJob(jobId), loadBillsForJob(jobId)]).then(function() {
                paintJobPurchaseOrdersInto(mount, jobId);
                // POs feed ACCRUED cost — now that they've loaded, refresh the
                // accrued tile + the phase matrix (per-phase accrued chip).
                try {
                    var accEl = document.getElementById('job-summary-accrued');
                    if (accEl && typeof getJobAccruedCosts === 'function') {
                        var poAcc = getJobPOAccrued(jobId).total || 0;
                        var acc = getJobAccruedCosts(jobId) + poAcc;
                        accEl.textContent = formatCurrency(acc);
                        var noteEl = document.getElementById('job-summary-accrued-note');
                        if (noteEl) noteEl.textContent = poAcc > 0 ? 'Open POs + earned/unbilled' : (acc > 0 ? 'Earned but unbilled' : '');
                    }
                    if (typeof renderJobPhases === 'function') renderJobPhases(jobId);
                } catch (e) {}
            });
        }
        function paintJobPurchaseOrdersInto(mount, jobId) {
            if (!mount) return;
            var rows = (appData.jobPurchaseOrders || []).filter(function(p) { return p.job_id === jobId; });
            rows.sort(function(a, b) { return new Date(b.updated_at || 0) - new Date(a.updated_at || 0); });
            function poStatusBadge(s) {
                s = String(s || 'draft').toLowerCase();
                var done = (s === 'approved' || s === 'closed' || s === 'work_complete');
                var color = done ? 'var(--green,#34d399)' : (s === 'issued' ? 'var(--accent,#4f8cff)' : '#cbd5e1');
                var bg = done ? 'rgba(52,211,153,0.12)' : (s === 'issued' ? 'rgba(79,140,255,0.12)' : 'rgba(148,163,184,0.12)');
                var label = s.replace(/_/g, ' ').replace(/\b\w/g, function(m) { return m.toUpperCase(); });
                return '<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700;letter-spacing:0.4px;text-transform:uppercase;color:' + color + ';background:' + bg + ';">' + escapeHTML(label) + '</span>';
            }
            var bodyHTML;
            if (!rows.length) {
                bodyHTML =
                    '<div style="padding:20px;border:1px dashed var(--border,#333);border-radius:10px;text-align:center;color:var(--text-dim,#888);font-size:12px;">' +
                        'No purchase orders yet. Click <strong>+ New Purchase Order</strong> to start one.' +
                    '</div>';
            } else {
                var rowsHTML = rows.map(function(p) {
                    var total = poRowTotal(p);
                    var billed = poRowBilled(p);
                    var outstanding = total - billed;
                    return '<tr class="overview-row" style="cursor:pointer;border-bottom:1px solid var(--overlay-light,rgba(255,255,255,0.04));" data-po-open="' + escapeHTML(p.id) + '" title="Click to open">' +
                        '<td style="white-space:nowrap;padding:8px 10px;"><strong style="color:var(--text,#fff);font-size:13px;">' + escapeHTML(p.po_number || 'PO') + '</strong></td>' +
                        '<td style="padding:8px 10px;font-size:12.5px;color:var(--text-dim,#aaa);">' + escapeHTML(p.sub_name || '—') + '</td>' +
                        '<td style="padding:8px 10px;font-size:12.5px;color:var(--text,#fff);">' + escapeHTML(p.title || '(untitled)') + '</td>' +
                        '<td style="white-space:nowrap;padding:8px 10px;">' + poStatusBadge(p.status) + '</td>' +
                        '<td class="num" style="text-align:right;white-space:nowrap;padding:8px 10px;font-family:\'SF Mono\',monospace;font-size:13px;color:var(--text,#fff);font-weight:600;">' + formatCurrency(total) + '</td>' +
                        '<td class="num" style="text-align:right;white-space:nowrap;padding:8px 10px;font-family:\'SF Mono\',monospace;font-size:13px;color:var(--text-dim,#aaa);">' + formatCurrency(billed) + '</td>' +
                        '<td class="num" style="text-align:right;white-space:nowrap;padding:8px 10px;font-family:\'SF Mono\',monospace;font-size:13px;color:' + (outstanding > 0.005 ? 'var(--yellow,#fbbf24)' : 'var(--green,#34d399)') + ';font-weight:600;">' + formatCurrency(outstanding) + '</td>' +
                    '</tr>';
                }).join('');
                bodyHTML =
                    '<div style="border:1px solid var(--border,#333);border-radius:10px;overflow-x:auto;background:var(--card-bg,#141419);">' +
                        '<table style="width:100%;border-collapse:collapse;">' +
                            '<thead style="background:var(--overlay-light,rgba(255,255,255,0.02));border-bottom:1px solid var(--border,#333);"><tr>' +
                                thCell('PO #', 'left') +
                                thCell('Sub', 'left') +
                                thCell('Title', 'left') +
                                thCell('Status', 'left') +
                                thCell('Total', 'right') +
                                thCell('Billed', 'right') +
                                thCell('Outstanding', 'right') +
                            '</tr></thead>' +
                            '<tbody>' + rowsHTML + '</tbody>' +
                        '</table>' +
                    '</div>';
            }
            mount.innerHTML =
                '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">' +
                    '<h3 style="font-size:13px;margin:0;">&#x1F4C4; Purchase Orders (' + rows.length + ')</h3>' +
                    '<div style="display:flex;gap:6px;">' +
                        '<button class="ee-btn" data-po-import="' + escapeHTML(jobId) + '" style="font-size:12px;" title="Import a Buildertrend Purchase Order PDF export">&#x2913; Import PDF</button>' +
                        '<button class="ee-btn primary" data-po-new="' + escapeHTML(jobId) + '" style="font-size:12px;">+ New Purchase Order</button>' +
                    '</div>' +
                '</div>' +
                bodyHTML;
            mount.querySelectorAll('[data-po-open]').forEach(function(tr) {
                tr.addEventListener('click', function() {
                    var id = tr.getAttribute('data-po-open');
                    if (window.p86PurchaseOrders && window.p86PurchaseOrders.open) window.p86PurchaseOrders.open(id);
                });
            });
            var newBtn = mount.querySelector('[data-po-new]');
            if (newBtn) newBtn.addEventListener('click', function() {
                if (window.p86PurchaseOrders && window.p86PurchaseOrders.openNew) {
                    window.p86PurchaseOrders.openNew(jobId);
                    // Best-effort refresh after the editor opens — it doesn't
                    // emit a close event, so re-fetch shortly after.
                    setTimeout(function() {
                        loadPurchaseOrdersForJob(jobId).then(function() { paintJobPurchaseOrdersInto(mount, jobId); });
                    }, 600);
                }
            });
            var impBtn = mount.querySelector('[data-po-import]');
            if (impBtn) impBtn.addEventListener('click', function() {
                if (window.p86PurchaseOrders && window.p86PurchaseOrders.importNew) {
                    // Extracts the PDF, matches the job from it (defaults to THIS
                    // job, confirms via picker on mismatch), then opens the PO.
                    window.p86PurchaseOrders.importNew(jobId);
                    setTimeout(function() {
                        loadPurchaseOrdersForJob(jobId).then(function() { paintJobPurchaseOrdersInto(mount, jobId); });
                    }, 1500);
                }
            });
        }

        function getJobPOTotals(jobId) {
            const pos = appData.purchaseOrders.filter(po => po.jobId === jobId);
            return {
                amount: pos.reduce((sum, po) => sum + (po.amount || 0), 0),
                billed: pos.reduce((sum, po) => sum + (po.billedToDate || 0), 0),
                count: pos.length
            };
        }

        // Populate the <datalist> the poVendor input reads from with
        // every active sub in appData.subsDirectory. Called every time
        // the modal opens (Add or Edit) so newly-added subs show up
        // without a page reload.
        function populatePOVendorDatalist() {
            var dl = document.getElementById('poVendorSubsList');
            if (!dl) return;
            var subs = (appData && Array.isArray(appData.subsDirectory))
                ? appData.subsDirectory.filter(function(s) {
                    return (s.status || 'active') !== 'closed';
                  })
                : [];
            subs.sort(function(a, b) { return (a.name || '').localeCompare(b.name || ''); });
            dl.innerHTML = subs.map(function(s) {
                // value is what gets typed into the input on selection;
                // label hint surfaces trade if present so duplicates
                // (e.g. two "Smith Drywall" companies) are distinguishable.
                var hint = s.trade ? ' · ' + s.trade : '';
                return '<option value="' + escapeHTML(s.name || '') + '">' +
                       escapeHTML((s.name || '') + hint) + '</option>';
            }).join('');
        }

        function openAddPOModal() {
            // Route to the modern server-backed PO editor (same one the PO
            // list's "+ New Purchase Order" uses). The legacy inline
            // addPOModal below wrote to appData.purchaseOrders — a dead store
            // the current list (appData.jobPurchaseOrders) never reads, so
            // those POs were invisible. Kept only as a defensive fallback.
            if (window.p86PurchaseOrders && typeof window.p86PurchaseOrders.openNew === 'function') {
                window.p86PurchaseOrders.openNew(appState.currentJobId);
                return;
            }
            document.getElementById('poModalHeader').textContent = 'Add Purchase Order';
            document.getElementById('poSaveBtn').innerHTML = '&#x1F4C4; Add Purchase Order';
            document.getElementById('poNumber').value = '';
            document.getElementById('poDate').value = new Date().toISOString().split('T')[0];
            document.getElementById('poVendor').value = '';
            document.getElementById('poDescription').value = '';
            document.getElementById('poAmount').value = '';
            document.getElementById('poBilled').value = '';
            document.getElementById('poStatus').value = 'Open';
            document.getElementById('poNotes').value = '';
            appState.editPOId = null;
            populatePOVendorDatalist();
            openModal('addPOModal');
        }

        function savePO() {
            const vendor = document.getElementById('poVendor').value.trim();
            if (!vendor) { alert('Enter a vendor name'); return; }
            // Resolve the typed/selected vendor name back to a directory
            // id so the PO record links into the canonical subs dataset.
            // Match is case-insensitive so the user doesn't have to nail
            // the exact casing the directory stores.
            var matchedSubId = null;
            try {
                var dir = (appData && Array.isArray(appData.subsDirectory)) ? appData.subsDirectory : [];
                var lower = vendor.toLowerCase();
                var match = dir.find(function(s) { return (s.name || '').toLowerCase() === lower; });
                if (match) matchedSubId = match.id;
            } catch (e) { /* defensive */ }
            const poData = {
                jobId: appState.currentJobId,
                poNumber: document.getElementById('poNumber').value.trim(),
                vendor: vendor,
                subId: matchedSubId,
                description: document.getElementById('poDescription').value.trim(),
                amount: parseFloat(document.getElementById('poAmount').value) || 0,
                billedToDate: parseFloat(document.getElementById('poBilled').value) || 0,
                date: document.getElementById('poDate').value,
                status: document.getElementById('poStatus').value,
                notes: document.getElementById('poNotes').value.trim()
            };
            if (appState.editPOId) {
                const idx = appData.purchaseOrders.findIndex(po => po.id === appState.editPOId);
                if (idx >= 0) Object.assign(appData.purchaseOrders[idx], poData);
            } else {
                poData.id = 'po' + Date.now();
                appData.purchaseOrders.push(poData);
            }
            saveData();
            closeModal('addPOModal');
            renderJobDetail(appState.currentJobId);
        }

        function editPO(poId) {
            const po = appData.purchaseOrders.find(p => p.id === poId);
            if (!po) return;
            appState.editPOId = poId;
            document.getElementById('poModalHeader').textContent = 'Edit Purchase Order';
            document.getElementById('poSaveBtn').innerHTML = '&#x1F4BE; Update Purchase Order';
            document.getElementById('poNumber').value = po.poNumber || '';
            document.getElementById('poDate').value = po.date || '';
            document.getElementById('poVendor').value = po.vendor || '';
            document.getElementById('poDescription').value = po.description || '';
            document.getElementById('poAmount').value = po.amount || '';
            document.getElementById('poBilled').value = po.billedToDate || '';
            document.getElementById('poStatus').value = po.status || 'Open';
            document.getElementById('poNotes').value = po.notes || '';
            populatePOVendorDatalist();
            openModal('addPOModal');
        }

        function deletePO(poId) {
            _confirmDelete('purchase order').then(function(ok) {
                if (!ok) return;
                appData.purchaseOrders = appData.purchaseOrders.filter(p => p.id !== poId);
                saveData();
                renderJobDetail(appState.currentJobId);
            });
        }

        function renderPurchaseOrders(jobId) {
            // Repointed to the server-backed job_purchase_orders entity (was
            // the legacy appData.purchaseOrders / #po-table). Renders the
            // same list the Jobs hub shows, filtered to this job; rows open
            // the dedicated PO editor (window.p86PurchaseOrders).
            var poHost = document.getElementById('job-purchaseorders');
            if (!poHost) return;
            poHost.innerHTML = '';
            renderJobPurchaseOrdersInto(poHost, jobId, 'job-subtab-purchase-orders');
        }

        // ==================== INVOICES ====================
        function getJobInvTotals(jobId) {
            const invs = appData.invoices.filter(inv => inv.jobId === jobId);
            return {
                amount: invs.reduce((sum, inv) => sum + (inv.amount || 0), 0),
                paid: invs.filter(inv => inv.status === 'Paid').reduce((sum, inv) => sum + (inv.amount || 0), 0),
                count: invs.length
            };
        }

        function openAddInvoiceModal() {
            document.getElementById('invModalHeader').textContent = 'Add Invoice';
            document.getElementById('invSaveBtn').innerHTML = '&#x1F4B3; Add Invoice';
            document.getElementById('invNumber').value = '';
            document.getElementById('invDate').value = new Date().toISOString().split('T')[0];
            document.getElementById('invDueDate').value = '';
            document.getElementById('invVendor').value = '';
            document.getElementById('invDescription').value = '';
            document.getElementById('invAmount').value = '';
            document.getElementById('invStatus').value = 'Draft';
            document.getElementById('invNotes').value = '';
            appState.editInvId = null;
            openModal('addInvModal');
        }

        function saveInvoice() {
            const vendor = document.getElementById('invVendor').value.trim();
            if (!vendor) { alert('Enter a vendor name'); return; }
            const invData = {
                jobId: appState.currentJobId,
                invNumber: document.getElementById('invNumber').value.trim(),
                vendor: vendor,
                description: document.getElementById('invDescription').value.trim(),
                amount: parseFloat(document.getElementById('invAmount').value) || 0,
                date: document.getElementById('invDate').value,
                dueDate: document.getElementById('invDueDate').value,
                status: document.getElementById('invStatus').value,
                notes: document.getElementById('invNotes').value.trim()
            };
            if (appState.editInvId) {
                const idx = appData.invoices.findIndex(inv => inv.id === appState.editInvId);
                if (idx >= 0) Object.assign(appData.invoices[idx], invData);
            } else {
                invData.id = 'inv' + Date.now();
                appData.invoices.push(invData);
            }
            saveData();
            closeModal('addInvModal');
            renderJobDetail(appState.currentJobId);
        }

        function editInvoice(invId) {
            const inv = appData.invoices.find(i => i.id === invId);
            if (!inv) return;
            appState.editInvId = invId;
            document.getElementById('invModalHeader').textContent = 'Edit Invoice';
            document.getElementById('invSaveBtn').innerHTML = '&#x1F4BE; Update Invoice';
            document.getElementById('invNumber').value = inv.invNumber || '';
            document.getElementById('invDate').value = inv.date || '';
            document.getElementById('invDueDate').value = inv.dueDate || '';
            document.getElementById('invVendor').value = inv.vendor || '';
            document.getElementById('invDescription').value = inv.description || '';
            document.getElementById('invAmount').value = inv.amount || '';
            document.getElementById('invStatus').value = inv.status || 'Draft';
            document.getElementById('invNotes').value = inv.notes || '';
            openModal('addInvModal');
        }

        function deleteInvoice(invId) {
            _confirmDelete('invoice').then(function(ok) {
                if (!ok) return;
                appData.invoices = appData.invoices.filter(i => i.id !== invId);
                saveData();
                renderJobDetail(appState.currentJobId);
            });
        }

        function renderInvoices(jobId) {
            const invs = appData.invoices.filter(inv => inv.jobId === jobId);
            const tbody = document.querySelector('#inv-table tbody');
            tbody.innerHTML = '';
            let totalAmt = 0;
            invs.forEach((inv, idx) => {
                totalAmt += inv.amount || 0;
                const statusColor = inv.status === 'Paid' ? 'var(--green)' : inv.status === 'Sent' ? 'var(--yellow)' : 'var(--text-dim)';
                const row = document.createElement('tr');
                row.innerHTML = `
                    <td>${escapeHTML(inv.invNumber) || 'INV-' + (idx + 1)}</td>
                    <td>${escapeHTML(inv.vendor)}</td>
                    <td>${escapeHTML(inv.description)}${inv.notes ? '<br><span style="font-size: 11px; color: var(--text-dim);">' + escapeHTML(inv.notes) + '</span>' : ''}</td>
                    <td style="text-align: right;">${formatCurrency(inv.amount)}</td>
                    <td><span style="color: ${statusColor}; font-weight: 600; font-size: 12px;">${escapeHTML(inv.status)}</span></td>
                    <td>${escapeHTML(inv.date) || '—'}</td>
                    <td>${escapeHTML(inv.dueDate) || '—'}</td>
                    <td>
                        <button class="ee-btn secondary" onclick="event.stopPropagation(); editInvoice('${escapeHTML(inv.id)}')">&#x270F;&#xFE0F; Edit</button>
                        <button class="ee-btn ee-icon-btn danger" onclick="event.stopPropagation(); deleteInvoice('${escapeHTML(inv.id)}')" title="Delete">&#x1F5D1;</button>
                    </td>`;
                tbody.appendChild(row);
            });
            document.getElementById('inv-total-amount').textContent = formatCurrency(totalAmt);
        }

        // Apply the same status + type filters renderJobsTable uses,
        // so the dashboard tiles and the visible rows ALWAYS reflect
        // the same set. Extracted so both can call it. Audit finding
        // W1 (memoized-inventing-mountain.md): pre-fix the tiles
        // looped over EVERY job (including Archived) while the table
        // default-hid Archived → user saw $2.1M on the tile but the
        // rows visible summed to $1.2M.
        // ── Shared filter drawer + saved views (mirrors Cost Inbox/Leads/Estimates)
        let _jobsDrawer = null, _jobsViews = [], _jobsActiveViewId = null, _jobsViewsLoaded = false;
        function jobsDistinct(accessor) {
            var seen = {}, out = [];
            (appData.jobs || []).forEach(function(j) { var v = accessor(j); if (v == null || v === '') return; v = String(v); if (seen[v]) return; seen[v] = true; out.push(v); });
            out.sort(function(a, b) { return a.toLowerCase().localeCompare(b.toLowerCase()); });
            return out;
        }
        // Address parts, derived from the structured fields or parsed from the
        // legacy freeform `address` (via the shared p86Address module) so both
        // new + old jobs filter correctly without a migration.
        function _jobAddr(j) { return (window.p86Address ? window.p86Address.get(j) : { street: '', city: j.city || '', state: j.state || '', zip: j.zip || '' }); }
        function jobsFilterFields() {
            var statusOpts = jobsDistinct(function(j) { return j.status; }).map(function(s) { return { v: s, label: s }; });
            var pmOpts = jobsDistinct(function(j) { return getJobOwnerName(j); }).map(function(s) { return { v: s, label: s }; });
            var jtOpts = jobsDistinct(function(j) { return j.jobType; }).map(function(s) { return { v: s, label: s }; });
            var mktOpts = jobsDistinct(function(j) { return j.market; }).map(function(s) { return { v: s, label: s }; });
            var cityOpts = jobsDistinct(function(j) { return _jobAddr(j).city; }).map(function(s) { return { v: s, label: s }; });
            var stateOpts = jobsDistinct(function(j) { return _jobAddr(j).state; }).map(function(s) { return { v: s, label: s }; });
            var zipOpts = jobsDistinct(function(j) { return _jobAddr(j).zip; }).map(function(s) { return { v: s, label: s }; });
            return [
                { key: 'status', label: 'Status', type: 'chips', options: statusOpts },
                { key: 'pm', label: 'PM', type: 'select', options: [{ v: '', label: 'Anyone' }].concat(pmOpts) },
                { key: 'jobType', label: 'Job Type', type: 'select', options: [{ v: '', label: 'Any' }].concat(jtOpts) },
                { key: 'market', label: 'Market', type: 'select', options: [{ v: '', label: 'Any' }].concat(mktOpts) },
                { key: 'city', label: 'City', type: 'select', options: [{ v: '', label: 'Any' }].concat(cityOpts) },
                { key: 'state', label: 'State', type: 'select', options: [{ v: '', label: 'Any' }].concat(stateOpts) },
                { key: 'zip', label: 'ZIP', type: 'select', options: [{ v: '', label: 'Any' }].concat(zipOpts) },
                { key: 'contract', label: 'Contract $', type: 'numrange' },
                { key: 'pctcomplete', label: '% Complete', type: 'numrange' },
                { key: 'margin', label: 'Margin %', type: 'numrange' },
                { key: 'linkage', label: 'Source', type: 'chips', options: [{ v: 'from_lead', label: 'From a lead' }, { v: 'has_estimate', label: 'Has estimate' }] }
            ];
        }
        function matchesJobDrawer(j, d) {
            if (!d) return true;
            var FD = window.p86FilterDrawer; if (!FD) return true;
            if (d.status && d.status.length && d.status.indexOf(j.status) < 0) return false;
            if (d.pm && String(getJobOwnerName(j)) !== String(d.pm)) return false;
            if (d.jobType && String(j.jobType || '') !== String(d.jobType)) return false;
            if (d.market && String(j.market || '') !== String(d.market)) return false;
            if (d.city || d.state || d.zip) { var _a = _jobAddr(j);
                if (d.city && String(_a.city || '') !== String(d.city)) return false;
                if (d.state && String(_a.state || '') !== String(d.state)) return false;
                if (d.zip && String(_a.zip || '') !== String(d.zip)) return false; }
            var w = null;
            var cr = FD.resolveNumRange(d.contract);
            if (cr.min != null || cr.max != null) { w = w || getJobWIP(j.id); var c = Number(w.totalIncome || 0); if (cr.min != null && c < cr.min) return false; if (cr.max != null && c > cr.max) return false; }
            var pr = FD.resolveNumRange(d.pctcomplete);
            if (pr.min != null || pr.max != null) { var p = Number(j.pctComplete || 0); if (pr.min != null && p < pr.min) return false; if (pr.max != null && p > pr.max) return false; }
            var mr = FD.resolveNumRange(d.margin);
            if (mr.min != null || mr.max != null) { w = w || getJobWIP(j.id); var m = Number(w.displayMargin || 0); if (mr.min != null && m < mr.min) return false; if (mr.max != null && m > mr.max) return false; }
            if (d.linkage && d.linkage.length) { if (d.linkage.indexOf('from_lead') >= 0 && !j.lead_id) return false; if (d.linkage.indexOf('has_estimate') >= 0 && !j.estimate_id) return false; }
            return true;
        }
        function updateJobsFilterBtn() {
            var btn = document.getElementById('jobs-filter-btn'); if (!btn) return;
            var FD = window.p86FilterDrawer;
            var n = (_jobsDrawer && FD) ? FD.countActive(jobsFilterFields(), _jobsDrawer) : 0;
            btn.innerHTML = (window.p86Icon ? window.p86Icon('funnel') : 'Filter') + (n ? ' <strong>(' + n + ')</strong>' : '');
            btn.classList.toggle('pf-on', n > 0);
        }
        function updateJobsViewsBtn() {
            var btn = document.getElementById('jobs-views-btn'); if (!btn) return;
            var v = _jobsViews.find(function(x) { return x.id === _jobsActiveViewId; });
            btn.innerHTML = (v ? escapeHTML(v.name) : 'Views') + ' ▾';
        }
        function jobsRerender() { if (typeof renderJobsTable === 'function') renderJobsTable(); }
        window.jobsOpenFilter = function() {
            var FD = window.p86FilterDrawer; if (!FD) return;
            var fields = jobsFilterFields();
            FD.open({
                title: 'Filter Jobs', fields: fields,
                values: _jobsDrawer || FD.emptyValues(fields),
                onApply: function(v) { _jobsDrawer = v; _jobsActiveViewId = null; updateJobsFilterBtn(); updateJobsViewsBtn(); jobsRerender(); },
                onClear: function() { _jobsDrawer = null; _jobsActiveViewId = null; updateJobsFilterBtn(); updateJobsViewsBtn(); jobsRerender(); }
            });
        };
        function jobsLoadViews() {
            if (!(window.p86Api && window.p86Api.listViews)) return Promise.resolve();
            return window.p86Api.listViews.list('jobs').then(function(r) {
                _jobsViews = (r && r.views) || [];
                var def = _jobsViews.find(function(v) { return v.is_default; });
                if (def && !_jobsDrawer && !_jobsActiveViewId) { _jobsActiveViewId = def.id; var cfg = def.config || {}; _jobsDrawer = (cfg.filters && Object.keys(cfg.filters).length) ? cfg.filters : null; jobsRerender(); }
                updateJobsFilterBtn(); updateJobsViewsBtn();
            }).catch(function() { _jobsViews = []; });
        }
        function applyJobsView(v) {
            _jobsActiveViewId = v.id;
            var cfg = v.config || {};
            _jobsDrawer = (cfg.filters && Object.keys(cfg.filters).length) ? cfg.filters : null;
            updateJobsFilterBtn(); updateJobsViewsBtn(); jobsRerender();
        }
        window.jobsOpenViews = function(anchor) {
            var existing = document.getElementById('jobs-views-pop');
            if (existing) { existing.remove(); return; }
            var pop = document.createElement('div');
            pop.id = 'jobs-views-pop';
            pop.style.cssText = 'position:fixed;z-index:100000;min-width:244px;background:var(--card-bg,#161a2b);border:1px solid var(--border,#333);border-radius:8px;padding:6px;box-shadow:0 8px 24px rgba(0,0,0,.45);font-size:13px;';
            var rows = _jobsViews.length ? _jobsViews.map(function(v) {
                return '<div data-view="' + escapeHTML(v.id) + '" style="display:flex;align-items:center;gap:6px;padding:4px 6px;border-radius:6px;">' +
                    '<span class="jv-apply" style="flex:1;cursor:pointer;">' + escapeHTML(v.name) + (v.is_default ? ' <span style="color:var(--text-dim,#888);font-size:10px;">(default)</span>' : '') + '</span>' +
                    '<a href="#" data-def="' + escapeHTML(v.id) + '" title="Set as default" style="text-decoration:none;">★</a>' +
                    '<a href="#" data-del="' + escapeHTML(v.id) + '" title="Delete" style="text-decoration:none;color:#f87171;">✕</a>' +
                '</div>';
            }).join('') : '<div style="padding:6px 8px;color:var(--text-dim,#888);">No saved views yet.</div>';
            pop.innerHTML = rows + '<div style="border-top:1px solid var(--border,#333);margin-top:6px;padding-top:6px;"><button type="button" class="ee-btn" id="jobs-save-view" style="width:100%;">＋ Save current filters as view…</button></div>';
            document.body.appendChild(pop);
            var r = anchor.getBoundingClientRect();
            pop.style.top = (r.bottom + 4) + 'px';
            pop.style.left = Math.max(8, Math.min(r.right - 244, window.innerWidth - 252)) + 'px';
            function close() { pop.remove(); document.removeEventListener('mousedown', onOut, true); }
            function onOut(e) { if (!pop.contains(e.target) && e.target !== anchor) close(); }
            setTimeout(function() { document.addEventListener('mousedown', onOut, true); }, 0);
            pop.querySelectorAll('.jv-apply').forEach(function(sp) { sp.addEventListener('click', function() { var id = sp.parentNode.getAttribute('data-view'); var v = _jobsViews.find(function(x) { return x.id === id; }); if (v) { close(); applyJobsView(v); } }); });
            pop.querySelectorAll('[data-def]').forEach(function(a) { a.addEventListener('click', function(e) { e.preventDefault(); e.stopPropagation(); window.p86Api.listViews.update(a.getAttribute('data-def'), { is_default: true }).then(jobsLoadViews).then(function() { close(); if (typeof window.p86Toast === 'function') window.p86Toast('Default view set', 'success'); }); }); });
            pop.querySelectorAll('[data-del]').forEach(function(a) { a.addEventListener('click', async function(e) { e.preventDefault(); e.stopPropagation(); if (!(await p86Ask('Delete this saved view?'))) return; var id = a.getAttribute('data-del'); window.p86Api.listViews.remove(id).then(function() { if (_jobsActiveViewId === id) _jobsActiveViewId = null; return jobsLoadViews(); }).then(close); }); });
            var sv = pop.querySelector('#jobs-save-view');
            if (sv) sv.addEventListener('click', function() {
                var name = prompt('Name this view:'); if (name == null) return; name = String(name).trim(); if (!name) return;
                window.p86Api.listViews.create({ page: 'jobs', name: name, config: { filters: _jobsDrawer || {} }, is_default: false })
                    .then(function(res) { _jobsActiveViewId = (res && res.view && res.view.id) || null; return jobsLoadViews(); })
                    .then(function() { close(); if (typeof window.p86Toast === 'function') window.p86Toast('View saved', 'success'); })
                    .catch(function() { if (typeof window.p86Toast === 'function') window.p86Toast('Could not save view', 'error'); });
            });
        };

        // ── Multi-select + bulk actions (mirrors the Leads bulk bar) ─────
        let _jobsSelected = new Set();   // job ids ticked; survives re-render
        function p86JobsSelect(id, checked) {
            if (checked) _jobsSelected.add(id); else _jobsSelected.delete(id);
            updateJobsBulkBar(); syncJobsSelectAll();
        }
        function p86JobsSelectAll(checked) {
            document.querySelectorAll('#jobs-table .job-check').forEach(function(b) {
                b.checked = checked;
                var id = b.getAttribute('data-id');
                if (checked) _jobsSelected.add(id); else _jobsSelected.delete(id);
            });
            updateJobsBulkBar();
        }
        function p86JobsClearSelection() {
            _jobsSelected.clear();
            document.querySelectorAll('#jobs-table .job-check').forEach(function(b) { b.checked = false; });
            syncJobsSelectAll(); updateJobsBulkBar();
        }
        function syncJobsSelectAll() {
            var all = document.getElementById('jobs-check-all');
            if (!all) return;
            var boxes = document.querySelectorAll('#jobs-table .job-check');
            var checked = 0;
            boxes.forEach(function(b) { if (b.checked) checked++; });
            all.checked = boxes.length > 0 && checked === boxes.length;
            all.indeterminate = checked > 0 && checked < boxes.length;
        }
        // In-app confirm — native confirm() silently returns false inside an
        // installed (standalone) PWA, so any bulk action gated on it would no-op
        // there (menu opens, option does nothing). p86Confirm is a DOM overlay
        // that works everywhere; fall back to native only if dialogs.js is absent.
        function bulkConfirm(opts) {
            opts = opts || {};
            // Two p86Confirm impls ship (dialogs.js + app.js) with different
            // option names — pass both so the button label + danger styling
            // apply whichever one is active.
            var o = {
                title: opts.title, message: opts.message,
                confirmLabel: opts.confirmLabel, confirmText: opts.confirmLabel,
                cancelLabel: opts.cancelLabel, cancelText: opts.cancelLabel,
                danger: !!opts.danger, destructive: !!opts.danger
            };
            return (typeof window.p86Confirm === 'function')
                ? window.p86Confirm(o)
                : Promise.resolve(window.confirm(opts.message || 'Are you sure?'));
        }
        function updateJobsBulkBar() {
            var bar = document.getElementById('jobs-bulkbar');
            if (!bar || !window.p86BulkRibbon) return;
            var n = _jobsSelected.size;
            if (!n) { window.p86BulkRibbon.hide(bar); return; }
            // Status options: the standard lifecycle set + any other statuses in use.
            var std = ['In Progress', 'On Hold', 'Completed', 'Archived'];
            var seen = {}; std.forEach(function(s) { seen[s] = true; });
            (appData.jobs || []).forEach(function(j) { if (j.status && !seen[j.status]) { seen[j.status] = true; std.push(j.status); } });
            var actions = [
                { icon: 'exports', title: 'Export selected to Excel', onClick: function() { window.p86JobsExportSelected(); } },
                { icon: 'bookmark', title: 'Set status', menu: std.map(function(s) { return { label: s, onClick: function() { window.p86JobsBulkStatus(s); } }; }) }
            ];
            if (window.p86Auth && window.p86Auth.isAdmin && window.p86Auth.isAdmin()) {
                var pms = (window.p86Admin && window.p86Admin.getActivePMs && window.p86Admin.getActivePMs()) || [];
                if (pms.length) actions.push({ icon: 'users', title: 'Assign PM', menu: pms.map(function(u) { return { label: u.name, onClick: function() { window.p86JobsBulkAssign(String(u.id), u.name); } }; }) });
            }
            actions.push({ icon: 'delete', title: 'Delete ' + n, danger: true, onClick: function() { window.p86JobsDeleteSelected(); } });
            window.p86BulkRibbon.render(bar, {
                count: n,
                onClear: function() { window.p86JobsClearSelection(); },
                actions: actions
            });
        }
        function jobsSelectedEditable() {
            return appData.jobs.filter(function(j) { return _jobsSelected.has(j.id) && j._canEdit !== false; });
        }
        function p86JobsBulkStatus(v) {
            if (!v) return;
            var jobs = jobsSelectedEditable();
            if (!jobs.length) { if (typeof window.p86Toast === 'function') window.p86Toast('No editable jobs selected.', 'error'); return; }
            bulkConfirm({ title: 'Set status', message: 'Set ' + jobs.length + ' job(s) to "' + v + '"?', confirmLabel: 'Set status' }).then(function(ok) {
                if (!ok) return;
                jobs.forEach(function(j) { j.status = v; });
                saveData();
                var skipped = _jobsSelected.size - jobs.length;
                if (typeof window.p86Toast === 'function') window.p86Toast('Status set on ' + jobs.length + ' job(s)' + (skipped ? ' (' + skipped + ' view-only skipped)' : '') + '.', 'success');
                _jobsSelected.clear();
                renderJobsTable();
            });
        }
        function p86JobsBulkAssign(uid, uname) {
            if (!uid) return;
            var ids = Array.from(_jobsSelected);
            if (!ids.length) return;
            bulkConfirm({ title: 'Assign PM', message: 'Assign ' + ids.length + ' job(s) to ' + (uname || 'this PM') + '?', confirmLabel: 'Assign' }).then(function(ok) {
                if (!ok) return;
                var proms = ids.map(function(id) {
                    return window.p86Api.jobs.reassignOwner(id, uid, false).then(function() {
                        var j = appData.jobs.find(function(x) { return x.id === id; });
                        if (j) { j.owner_id = Number(uid); j.pm = uname || j.pm; }
                        return true;
                    }).catch(function() { return false; });
                });
                Promise.all(proms).then(function(res) {
                    var ok2 = res.filter(Boolean).length, fail = res.length - ok2;
                    if (typeof window.p86Toast === 'function') window.p86Toast('Reassigned ' + ok2 + ' job(s)' + (fail ? ', ' + fail + ' failed' : '') + '.', fail ? 'error' : 'success');
                    _jobsSelected.clear();
                    renderJobsTable();
                });
            });
        }
        function p86JobsDeleteSelected() {
            var ids = Array.from(_jobsSelected);
            if (!ids.length) return;
            bulkConfirm({ title: 'Delete jobs', message: 'Permanently delete ' + ids.length + ' job(s) and all their data? This cannot be undone.', confirmLabel: 'Delete', danger: true }).then(function(ok) {
                if (!ok) return;
                var idSet = new Set(ids);
                appData.jobs = appData.jobs.filter(function(j) { return !idSet.has(j.id); });
                appData.buildings = appData.buildings.filter(function(b) { return !idSet.has(b.jobId); });
                appData.phases = appData.phases.filter(function(p) { return !idSet.has(p.jobId); });
                appData.changeOrders = appData.changeOrders.filter(function(c) { return !idSet.has(c.jobId); });
                appData.subs = appData.subs.filter(function(s) { return !idSet.has(s.jobId); });
                appData.purchaseOrders = (appData.purchaseOrders || []).filter(function(p) { return !idSet.has(p.jobId); });
                appData.invoices = (appData.invoices || []).filter(function(i) { return !idSet.has(i.jobId); });
                try {
                    var all = JSON.parse(localStorage.getItem('p86-nodegraphs') || '{}');
                    ids.forEach(function(id) { delete all[id]; });
                    localStorage.setItem('p86-nodegraphs', JSON.stringify(all));
                } catch (e) {}
                saveData();
                // bulk-save only upserts — server-side delete per id or they resurrect.
                if (window.p86Api && window.p86Api.isAuthenticated()) {
                    ids.forEach(function(id) { window.p86Api.jobs.remove(id).catch(function(err) { console.warn('Server delete failed for ' + id + ':', err.message); }); });
                }
                _jobsSelected.clear();
                if (typeof window.p86Toast === 'function') window.p86Toast('Deleted ' + ids.length + ' job(s).', 'success');
                renderJobsTable();
            });
        }
        function p86JobsExportSelected() {
            var rows = appData.jobs.filter(function(j) { return _jobsSelected.has(j.id); });
            if (!rows.length) { if (typeof window.p86Toast === 'function') window.p86Toast('Nothing selected.', 'error'); return; }
            var load = (typeof XLSX !== 'undefined') ? Promise.resolve(window.XLSX) : new Promise(function(resolve, reject) {
                var ex = document.getElementById('p86-xlsx-cdn');
                if (ex) { ex.addEventListener('load', function() { resolve(window.XLSX); }); ex.addEventListener('error', reject); return; }
                var s = document.createElement('script');
                s.id = 'p86-xlsx-cdn';
                s.src = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js';
                s.onload = function() { resolve(window.XLSX); };
                s.onerror = function() { reject(new Error('Could not load the Excel library.')); };
                document.head.appendChild(s);
            });
            load.then(function(XLSX) {
                var header = ['Job #', 'Title', 'Client', 'PM', 'Status', 'Type', 'Market', 'Total Income', '% Complete', 'Gross Profit', 'Margin %', 'Address', 'Job ID'];
                var aoa = [header];
                rows.forEach(function(j) {
                    var w = getJobWIP(j.id);
                    aoa.push([
                        j.jobNumber || '', j.title || '', j.client || '', getJobOwnerName(j) || '',
                        j.status || '', j.jobType || '', j.market || '',
                        Number(w.totalIncome || 0), Number(j.pctComplete || 0),
                        Number(w.displayProfit || 0), Number((w.displayMargin || 0).toFixed(1)),
                        j.address || [j.street_address, j.city, j.state].filter(Boolean).join(', ') || '',
                        j.id
                    ]);
                });
                var ws = XLSX.utils.aoa_to_sheet(aoa);
                ws['!cols'] = header.map(function(h) { return { wch: h === 'Title' || h === 'Address' ? 32 : h === 'Job ID' ? 24 : 14 }; });
                var wb = XLSX.utils.book_new();
                XLSX.utils.book_append_sheet(wb, ws, 'Jobs');
                XLSX.writeFile(wb, 'Jobs_' + new Date().toISOString().slice(0, 10) + '.xlsx');
                if (typeof window.p86Toast === 'function') window.p86Toast('Exported ' + rows.length + ' job(s).', 'success');
            }).catch(function(e) {
                if (typeof window.p86Toast === 'function') window.p86Toast('Export failed: ' + (e && e.message || 'error'), 'error');
            });
        }
        window.p86JobsSelect = p86JobsSelect;
        window.p86JobsSelectAll = p86JobsSelectAll;
        window.p86JobsClearSelection = p86JobsClearSelection;
        window.p86JobsBulkStatus = p86JobsBulkStatus;
        window.p86JobsBulkAssign = p86JobsBulkAssign;
        window.p86JobsDeleteSelected = p86JobsDeleteSelected;
        window.p86JobsExportSelected = p86JobsExportSelected;

        function getFilteredJobs() {
            let jobs = appData.jobs;
            const filter = appState.currentStatusFilter;
            var drawerHasStatus = !!(_jobsDrawer && _jobsDrawer.status && _jobsDrawer.status.length);
            if (filter) {
                jobs = jobs.filter(j => j.status === filter);
            } else if (drawerHasStatus) {
                // The drawer's Status chips control the status set (may include Archived).
            } else {
                // "All Active" = hide Archived by default
                jobs = jobs.filter(j => j.status !== 'Archived');
            }
            const typeFilter = appState.currentTypeFilter;
            if (typeFilter) {
                jobs = jobs.filter(j => (j.jobType || getJobTypeLabel(getJobType(j.jobNumber))) === typeFilter);
            }
            if (_jobsDrawer) jobs = jobs.filter(j => matchesJobDrawer(j, _jobsDrawer));
            return jobs;
        }

        // Jobs map view — toolbar 🗺 toggle swaps the table for the shared
        // list+map pane (js/projects-map.js). Pins come from geocode_lat/lng,
        // which the weather route fills lazily per job; jobs without coords
        // land in the pane's "Unmapped" list.
        let _jobsMapView = false;
        function toggleJobsMapView() {
            const tableWrap = document.querySelector('#jobs-main-view .table-container');
            const host = document.getElementById('jobs-map-host');
            const btn = document.getElementById('jobs-map-toggle');
            if (!host) return;
            _jobsMapView = !_jobsMapView;
            if (btn) {
                btn.style.background = _jobsMapView ? 'rgba(79,140,255,0.18)' : '';
                btn.style.borderColor = _jobsMapView ? '#4f8cff' : '';
                btn.style.color = _jobsMapView ? '#93c5fd' : '';
            }
            if (!_jobsMapView) {
                host.style.display = 'none';
                if (tableWrap) tableWrap.style.display = '';
                return;
            }
            if (tableWrap) tableWrap.style.display = 'none';
            host.style.display = '';
            const jobs = getFilteredJobs();
            if (window.p86ProjectsMap && typeof window.p86ProjectsMap.render === 'function') {
                window.p86ProjectsMap.render(host, jobs, {
                    entityLabel: 'jobs',
                    showThumb: false,
                    getName: function(j) {
                        return (j.jobNumber ? j.jobNumber + ' — ' : '') + (j.title || 'Untitled job');
                    },
                    getAddress: function(j) { return j.geocode_address || j.address || ''; },
                    getMeta: function(j) {
                        return (j.status || '') + (j.client ? ' · ' + j.client : '');
                    },
                    onPin: function(id) { editJob(id); }
                });
            } else {
                host.innerHTML = '<div style="padding:20px;color:var(--text-dim,#888);text-align:center;">Map module not loaded.</div>';
            }
        }
        window.toggleJobsMapView = toggleJobsMapView;

        function calculateJobsSummary() {
            // The job-list KPI tiles (Total Pipeline / Active Jobs / Total
            // Cost / Total Profit) were removed from the Jobs view — these
            // metrics are moving to the Insights page, which will own the
            // richer roll-up. Kept as a no-op so the existing call sites
            // (renderJobs + filterJobs) stay valid; restore the body here
            // if the tiles ever return to this page.
        }

        function getJobType(jobNumber) {
            if (!jobNumber) return '';
            const num = jobNumber.toUpperCase().trim();
            if (num.startsWith('RV')) return 'RV';
            if (num.startsWith('WO')) return 'WO';
            if (num.startsWith('S')) return 'S';
            return '';
        }

        function getJobTypeLabel(type) {
            if (type === 'S') return 'Service';
            if (type === 'RV') return 'Renovation';
            if (type === 'WO') return 'Work Order';
            return '';
        }

        function renderJobsTable() {
            const tbody = document.querySelector('#jobs-table tbody');
            tbody.innerHTML = '';
            if (!_jobsViewsLoaded) { _jobsViewsLoaded = true; jobsLoadViews(); }
            updateJobsFilterBtn(); updateJobsViewsBtn();

            // Shared filter logic via getFilteredJobs so the table
            // and dashboard tiles always reflect the same set.
            let jobs = getFilteredJobs();

            // Apply sorting
            if (appState.sortColumn) {
                const col = appState.sortColumn;
                const dir = appState.sortDirection === 'asc' ? 1 : -1;
                jobs = [...jobs].sort((a, b) => {
                    let va, vb;
                    switch(col) {
                        case 'name':
                            va = ((a.jobNumber || '') + ' ' + (a.title || '')).toLowerCase();
                            vb = ((b.jobNumber || '') + ' ' + (b.title || '')).toLowerCase();
                            return va.localeCompare(vb) * dir;
                        case 'market':
                            va = (a.market || '').toLowerCase();
                            vb = (b.market || '').toLowerCase();
                            return va.localeCompare(vb) * dir;
                        case 'status':
                            va = (a.status || '').toLowerCase();
                            vb = (b.status || '').toLowerCase();
                            return va.localeCompare(vb) * dir;
                        case 'client':
                            va = (a.client || '').toLowerCase();
                            vb = (b.client || '').toLowerCase();
                            return va.localeCompare(vb) * dir;
                        case 'pm':
                            va = (a.pm || '').toLowerCase();
                            vb = (b.pm || '').toLowerCase();
                            return va.localeCompare(vb) * dir;
                        case 'contract':
                            return (getJobWIP(a.id).totalIncome - getJobWIP(b.id).totalIncome) * dir;
                        case 'pctcomplete':
                            return ((a.pctComplete || 0) - (b.pctComplete || 0)) * dir;
                        case 'profit':
                            return (getJobWIP(a.id).displayProfit - getJobWIP(b.id).displayProfit) * dir;
                        case 'margin':
                            return (getJobWIP(a.id).displayMargin - getJobWIP(b.id).displayMargin) * dir;
                        default:
                            return 0;
                    }
                });
            }

            // Update sort indicator classes on headers
            document.querySelectorAll('#jobs-table th.sortable').forEach(th => {
                th.classList.remove('sort-asc', 'sort-desc');
                if (th.dataset.sort === appState.sortColumn) {
                    th.classList.add(appState.sortDirection === 'asc' ? 'sort-asc' : 'sort-desc');
                }
            });

            jobs.forEach((job, index) => {
                // The Jobs main row used to auto-recalc pctComplete here, but
                // that runs without the node-graph compute step the detail
                // view uses, so it produced different values than the metric
                // strip and would clobber the correct stored value. Now we
                // just read what's stored — the detail view (renderJobDetail)
                // is the single source of truth for keeping job.pctComplete
                // fresh. recalcSubCosts is still cheap and useful here for
                // dollar columns.
                if (appData.phases.some(p => p.jobId === job.id) || appData.buildings.some(b => b.jobId === job.id)) {
                    recalcSubCosts(job.id);
                }
                const w = getJobWIP(job.id);
                const statusClass = job.status === 'On Hold' ? 'at-risk' : job.status === 'Completed' ? 'on-track' : job.status === 'Archived' ? 'not-started' : 'on-track';
                const typeLabel = job.jobType ? `<span style="font-size: 11px; color: var(--text-dim); font-weight: normal; margin-left: 6px;">${escapeHTML(job.jobType)}${job.market ? ' - ' + escapeHTML(job.market) : ''}</span>` : '';

                const row = document.createElement('tr');
                row.style.cursor = 'pointer';
                row.onclick = function() { editJob(job.id); };
                // Subtle read-only indicator for PMs viewing jobs they don't own.
                // The row is still clickable (they can view detail), just visually muted.
                var readOnly = job._canEdit === false;
                if (readOnly) {
                    row.style.opacity = '0.6';
                    row.title = 'View only — assigned to ' + (job.pm || 'another PM');
                }
                var pmCell = escapeHTML(getJobOwnerName(job));
                if (readOnly) pmCell += ' <span style="font-size:9px;color:var(--text-dim,#888);margin-left:4px;">view only</span>';
                row.innerHTML = `
                    <td class="job-check-cell" style="width:34px;text-align:center;" onclick="event.stopPropagation();"><input type="checkbox" class="job-check" data-id="${escapeHTML(job.id)}" ${_jobsSelected.has(job.id) ? 'checked' : ''} onclick="event.stopPropagation();window.p86JobsSelect('${escapeHTML(job.id)}',this.checked);"></td>
                    <td data-col="idx">${index + 1}</td>
                    <td data-col="name"><strong>${job.jobNumber ? escapeHTML(job.jobNumber) + ' — ' : ''}${escapeHTML(job.title)}</strong>${typeLabel}</td>
                    <td data-col="client">${escapeHTML(job.client) || '—'}</td>
                    <td data-col="pm">${pmCell}</td>
                    <td data-col="status"><span class="badge ${statusClass}">${escapeHTML(job.status)}</span></td>
                    <td data-col="contract" style="text-align: right;">${formatCurrency(w.totalIncome)}</td>
                    <td data-col="pctcomplete" style="text-align: right;"><div class="progress-bar" style="margin-bottom: 2px; height: 6px;"><div class="progress-fill" style="width: ${w.pctComplete}%"></div></div><span style="font-size: 12px;">${w.pctComplete.toFixed(1)}%</span></td>
                    <td data-col="profit" style="text-align: right; color: ${w.displayProfit >= 0 ? 'var(--green)' : 'var(--red)'};">${formatCurrency(w.displayProfit)}</td>
                    <td data-col="margin" style="text-align: right;">${w.displayMargin.toFixed(1)}%</td>
                `;
                tbody.appendChild(row);
            });

            // Reorderable / resizable / freezable columns + internal scroll.
            if (window.p86Tables) window.p86Tables.enhance('jobs');
            syncJobsSelectAll(); updateJobsBulkBar();
        }

        function sortJobsTable(column) {
            if (appState.sortColumn === column) {
                // Toggle direction, or clear if already desc
                if (appState.sortDirection === 'asc') {
                    appState.sortDirection = 'desc';
                } else {
                    appState.sortColumn = null;
                    appState.sortDirection = null;
                }
            } else {
                appState.sortColumn = column;
                appState.sortDirection = 'asc';
            }
            renderJobsTable();
        }

        function filterJobs() {
            appState.currentStatusFilter = document.getElementById('statusFilter').value;
            appState.currentTypeFilter = document.getElementById('typeFilter').value;
            renderJobsTable();
            // Tiles follow the filter — see calculateJobsSummary docs
            // for the W1 audit context. Without this, the user would
            // change the filter and watch the rows update but the
            // tile totals stay frozen on the prior set.
            calculateJobsSummary();
        }

        function openAddJobModal() {
            document.getElementById('jobNumber').value = '';
            document.getElementById('jobTitle').value = '';
            document.getElementById('jobClient').value = '';
            var clientIdEl = document.getElementById('jobClientId');
            if (clientIdEl) clientIdEl.value = '';
            document.getElementById('jobType').value = '';
            document.getElementById('jobWorkType').value = '';
            document.getElementById('jobMarket').value = '';
            document.getElementById('jobContractAmount').value = '';
            document.getElementById('jobEstimatedCosts').value = '';
            document.getElementById('jobTargetMargin').value = '50';
            // Schedule page reads totalProductionDays for daily-revenue math.
            var prodDaysEl = document.getElementById('jobTotalProductionDays');
            if (prodDaysEl) prodDaysEl.value = '';
            document.getElementById('jobStatus').value = 'New';
            document.getElementById('jobNotes').value = '';
            populateJobPMSelect();
            populateJobClientPicker('jobClientPicker', '');
            openModal('addJobModal');
        }

        // Populate the client <select> (and mount the searchable widget over
        // it) so users can attach jobs to a clients-directory record. The
        // picker hands back the client id which we stash in #jobClientId.
        // The free-text #jobClient input stays as a free-form fallback for
        // clients that aren't in the directory yet.
        //
        // Critical: the searchable widget reads from clients.js's internal
        // _clients cache, NOT from the <select>'s options. We have to call
        // p86Clients.ensureLoaded() first so the cache is populated; only
        // then is mounting actually useful.
        function populateJobClientPicker(selectId, currentClientId) {
            var sel = document.getElementById(selectId);
            if (!sel) return;
            var fill = function(list) {
                var html = '<option value="">— Pick from directory (optional) —</option>';
                list.slice().sort(function(a, b) {
                    return (a.name || '').localeCompare(b.name || '');
                }).forEach(function(c) {
                    var selAttr = c.id === currentClientId ? ' selected' : '';
                    html += '<option value="' + escapeHTML(c.id) + '"' + selAttr + '>' +
                            escapeHTML(c.name || '(unnamed)') + '</option>';
                });
                sel.innerHTML = html;
                sel.value = currentClientId || '';
                if (window.p86Clients && typeof window.p86Clients.mountPicker === 'function') {
                    var handle = window.p86Clients.mountPicker(sel, function() {
                        // The widget triggers a change event on the select
                        // when a row is picked; the inline onchange attr
                        // (onJobClientPicked) handles syncing the displayed
                        // name + hidden id input.
                    });
                    if (handle && typeof handle.refreshLabel === 'function') handle.refreshLabel();
                }
            };
            if (window.p86Clients && typeof window.p86Clients.ensureLoaded === 'function') {
                window.p86Clients.ensureLoaded().then(fill);
            } else if (window.p86Api && window.p86Api.isAuthenticated && window.p86Api.isAuthenticated()) {
                window.p86Api.clients.list().then(function(res) {
                    fill((res && res.clients) || []);
                }).catch(function() { fill([]); });
            } else {
                sel.innerHTML = '<option value="">— Client directory unavailable in offline mode —</option>';
            }
        }

        // ──────────────────────────────────────────────────────────────────
        // Link Client modal — suggests directory matches for the job's
        // existing free-text client name and lets the user pick one (or
        // pick from the full directory) to attach as the structured link.
        // Also exposes "Unlink" when a link already exists. Persists
        // through the same saveData() path so the change rides the
        // existing bulk-save round-trip.
        // ──────────────────────────────────────────────────────────────────
        function openJobClientLinkModal(jobId) {
            var job = appData.jobs.find(function (j) { return j.id === jobId; });
            if (!job) return;
            var prior = document.getElementById('jobClientLinkModal');
            if (prior) prior.remove();

            var paint = function (clients) {
                var modal = document.createElement('div');
                modal.id = 'jobClientLinkModal';
                modal.className = 'modal active';

                var current = job.clientId
                    ? clients.find(function (c) { return c.id === job.clientId; })
                    : null;
                var suggestions = [];
                if (!current && job.client) {
                    var needle = String(job.client).trim().toLowerCase();
                    suggestions = clients.map(function (c) {
                        var hay = String(c.name || '').toLowerCase();
                        // Score: 100 for an exact match, 70 if needle is contained
                        // in hay (or vice versa), 0 otherwise. Substring on either
                        // direction catches "RPM" → "RPM Property Mgmt" AND
                        // "Wimbledon" → "Wimbledon Greens HOA".
                        var score = 0;
                        if (hay === needle) score = 100;
                        else if (hay.indexOf(needle) !== -1 || needle.indexOf(hay) !== -1) score = 70;
                        return { client: c, score: score };
                    }).filter(function (x) { return x.score > 0; })
                      .sort(function (a, b) { return b.score - a.score; })
                      .slice(0, 5);
                }

                var suggestionHtml = '';
                if (suggestions.length) {
                    suggestionHtml = '<div style="margin-top:14px;">' +
                      '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-dim,#888);margin-bottom:6px;">' +
                        'Suggested matches for &ldquo;' + escapeHTML(job.client || '') + '&rdquo;' +
                      '</div>';
                    suggestionHtml += suggestions.map(function (s) {
                        var c = s.client;
                        var addr = c.property_address || c.address || '';
                        var meta = [c.city, c.state].filter(Boolean).join(', ');
                        return '<button type="button" class="ee-btn secondary" ' +
                                'onclick="confirmLinkJobClient(\'' + escapeHTML(jobId) + '\', \'' + escapeHTML(c.id) + '\')" ' +
                                'style="display:block;width:100%;text-align:left;margin-bottom:4px;padding:8px 10px;">' +
                            '<div style="font-weight:600;">' + escapeHTML(c.name || '(unnamed)') +
                              (s.score === 100 ? ' <span style="color:#34d399;font-size:10px;">EXACT MATCH</span>' : '') + '</div>' +
                            (addr ? '<div style="font-size:11px;color:var(--text-dim,#888);">' +
                                escapeHTML(addr) + (meta ? ' · ' + escapeHTML(meta) : '') + '</div>' : '') +
                          '</button>';
                    }).join('');
                    suggestionHtml += '</div>';
                }

                var pickerHtml = '<div style="margin-top:14px;">' +
                  '<label style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-dim,#888);">' +
                    (suggestions.length ? 'Or pick from full directory' : 'Pick from directory') +
                  '</label>' +
                  '<select id="jobClientLinkPicker" style="width:100%;margin-top:6px;">' +
                    '<option value="">— Select a client —</option>' +
                  '</select>' +
                '</div>';

                var currentHtml = current
                    ? '<div style="background:rgba(52,211,153,0.10);border:1px solid rgba(52,211,153,0.35);' +
                      'border-radius:6px;padding:10px 12px;margin-bottom:14px;">' +
                        '<div style="font-size:11px;color:var(--text-dim,#888);margin-bottom:2px;">CURRENTLY LINKED</div>' +
                        '<div style="font-weight:600;">' + escapeHTML(current.name || '(unnamed)') + '</div>' +
                        (current.property_address || current.address
                          ? '<div style="font-size:11px;color:var(--text-dim,#888);margin-top:4px;">' +
                              escapeHTML(current.property_address || current.address) + '</div>'
                          : '') +
                    '</div>'
                    : '';

                modal.innerHTML =
                  '<div class="modal-content" style="max-width:520px;">' +
                    '<div class="modal-header">Link client record</div>' +
                    currentHtml +
                    suggestionHtml +
                    pickerHtml +
                    '<div class="modal-footer" style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px;">' +
                      (current
                        ? '<button class="ee-btn" style="margin-right:auto;color:#f87171;border-color:rgba(248,113,113,0.4);" ' +
                          'onclick="confirmLinkJobClient(\'' + escapeHTML(jobId) + '\', \'\')">Unlink</button>'
                        : '') +
                      '<button class="ee-btn secondary" onclick="closeJobClientLinkModal()">Cancel</button>' +
                      '<button class="ee-btn primary" id="jobClientLinkConfirm" disabled>Link</button>' +
                    '</div>' +
                  '</div>';
                document.body.appendChild(modal);

                // Populate the directory picker.
                var pickEl = modal.querySelector('#jobClientLinkPicker');
                clients.slice().sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); })
                    .forEach(function (c) {
                        var opt = document.createElement('option');
                        opt.value = c.id;
                        opt.textContent = c.name || '(unnamed)';
                        pickEl.appendChild(opt);
                    });
                if (window.p86Clients && typeof window.p86Clients.mountPicker === 'function') {
                    window.p86Clients.mountPicker(pickEl, function () {
                        var btn = modal.querySelector('#jobClientLinkConfirm');
                        if (btn) btn.disabled = !pickEl.value;
                    });
                }
                pickEl.addEventListener('change', function () {
                    var btn = modal.querySelector('#jobClientLinkConfirm');
                    if (btn) btn.disabled = !pickEl.value;
                });

                modal.querySelector('#jobClientLinkConfirm').onclick = function () {
                    var id = pickEl.value;
                    if (!id) return;
                    confirmLinkJobClient(jobId, id);
                };
                modal.addEventListener('click', function (e) {
                    if (e.target === modal) closeJobClientLinkModal();
                });
            };

            // Make sure clients-directory cache is hydrated before painting.
            // The searchable picker mounts on the select but reads its rows
            // from clients.js's internal _clients cache — empty cache → empty
            // popover. ensureLoaded() returns a promise that resolves once
            // the cache is populated (or immediately if already cached).
            if (window.p86Clients && typeof window.p86Clients.ensureLoaded === 'function') {
                window.p86Clients.ensureLoaded().then(paint);
            } else if (window.p86Api && window.p86Api.isAuthenticated && window.p86Api.isAuthenticated()) {
                window.p86Api.clients.list().then(function (res) {
                    paint((res && res.clients) || []);
                }).catch(function () { paint([]); });
            } else {
                paint([]);
            }
        }

        function closeJobClientLinkModal() {
            var m = document.getElementById('jobClientLinkModal');
            if (m) m.remove();
        }

        function confirmLinkJobClient(jobId, clientId) {
            var job = appData.jobs.find(function (j) { return j.id === jobId; });
            if (!job) return;
            job.clientId = clientId || null;
            // Sync the displayed client name to the linked record's name
            // when linking; leave it untouched on unlink so users don't
            // suddenly see a blank field where they typed a name.
            if (clientId) {
                var clients = (window.p86Clients && window.p86Clients.getCached) ? window.p86Clients.getCached() : [];
                var c = clients.find(function (x) { return x.id === clientId; });
                if (c && c.name) job.client = c.name;
            }
            job.updatedAt = new Date().toISOString();
            saveData();
            closeJobClientLinkModal();
            // Re-render so the button label flips and the weather widget
            // re-fetches against the newly available client address.
            renderJobDetail(jobId);
        }

        // ── Editable Project Address (Places autocomplete) ──────────────
        // Inline-edit a job's address so any job (even one with no source
        // lead) can be located + geocoded. Picking a Places result fills the
        // fields cleanly; Save persists to job.data and kicks the weather
        // geocoder (which populates geocode_lat/lng for the map + Site Plan).
        function editJobAddress(jobId) {
            var job = (window.appData && appData.jobs || []).find(function (j) { return j.id === jobId; });
            if (!job) return;
            var cell = document.getElementById('job-info-address');
            if (!cell) return;
            var esc = function (s) { return escapeHTML(s == null ? '' : String(s)); };
            cell.innerHTML =
                '<div class="job-addr-ac-mount" style="margin-bottom:6px;"></div>' +
                '<input id="job-addr-street" placeholder="Street" value="' + esc(job.street_address) + '" style="width:100%;margin-bottom:6px;" />' +
                '<div style="display:grid;grid-template-columns:1fr 60px 90px;gap:6px;margin-bottom:8px;">' +
                  '<input id="job-addr-city" placeholder="City" value="' + esc(job.city) + '" />' +
                  '<input id="job-addr-state" placeholder="ST" maxlength="2" value="' + esc(job.state) + '" style="text-transform:uppercase;" />' +
                  '<input id="job-addr-zip" placeholder="Zip" maxlength="10" value="' + esc(job.zip) + '" />' +
                '</div>' +
                '<div style="display:flex;gap:6px;">' +
                  '<button onclick="saveJobAddress(\'' + esc(jobId) + '\')" class="btn-primary" style="padding:4px 12px;cursor:pointer;">Save</button>' +
                  '<button onclick="renderJobDetail(\'' + esc(jobId) + '\')" style="padding:4px 12px;cursor:pointer;">Cancel</button>' +
                '</div>';
            if (window.p86AddressAutocomplete) {
                window.p86AddressAutocomplete.attach({
                    mount: cell.querySelector('.job-addr-ac-mount'),
                    placeholder: 'Search address…',
                    onPlace: function (r) {
                        var set = function (id, v) { var el = document.getElementById(id); if (el && v) el.value = v; };
                        set('job-addr-street', r.components.street_address || r.formatted);
                        set('job-addr-city', r.components.city);
                        set('job-addr-state', r.components.state);
                        set('job-addr-zip', r.components.zip);
                    }
                });
            }
        }
        function saveJobAddress(jobId) {
            var job = (window.appData && appData.jobs || []).find(function (j) { return j.id === jobId; });
            if (!job) return;
            var val = function (id) { var el = document.getElementById(id); return el ? el.value.trim() : ''; };
            job.street_address = val('job-addr-street');
            job.city = val('job-addr-city');
            job.state = val('job-addr-state').toUpperCase();
            job.zip = val('job-addr-zip');
            job.address = [job.street_address, job.city, job.state, job.zip].filter(Boolean).join(', ');
            job.updatedAt = new Date().toISOString();
            saveData();
            // Best-effort: geocode the new address server-side so the map /
            // Site Plan satellite get coordinates (reuses the weather geocoder).
            try {
                if (window.p86Api && p86Api.weather && p86Api.weather.jobs) p86Api.weather.jobs([jobId]).catch(function () {});
            } catch (_) {}
            renderJobDetail(jobId);
        }
        window.editJobAddress = editJobAddress;
        window.saveJobAddress = saveJobAddress;

        // Wired to the picker's onchange attribute. When the user picks a
        // client from the dropdown, copy its name into the free-text field
        // and stash the id on the hidden input so saveJob persists it.
        function onJobClientPicked(mode) {
            var pickerId = mode === 'edit' ? 'edit-jobClientPicker' : 'jobClientPicker';
            var nameId = mode === 'edit' ? 'edit-jobClient' : 'jobClient';
            var hiddenId = mode === 'edit' ? 'edit-jobClientId' : 'jobClientId';
            var picker = document.getElementById(pickerId);
            if (!picker) return;
            var id = picker.value;
            var hidden = document.getElementById(hiddenId);
            if (hidden) hidden.value = id || '';
            if (!id) return;
            var clients = (window.p86Clients && window.p86Clients.getCached) ? window.p86Clients.getCached() : [];
            var c = clients.find(function(x) { return x.id === id; });
            if (!c) return;
            var nameEl = document.getElementById(nameId);
            if (nameEl) nameEl.value = c.name || '';
        }

        // Populate the PM <select> from cached users when authenticated. For admins,
        // any active PM/admin can be assigned. For PMs themselves, lock the field
        // to their own user. Falls back to the legacy hardcoded list when offline.
        function populateJobPMSelect() {
            var sel = document.getElementById('jobPM');
            if (!sel) return;
            var auth = window.p86Auth;
            var admin = window.p86Admin;
            if (!auth || auth.isOffline() || !admin) {
                // Legacy / offline mode — keep the static dropdown as-is
                sel.value = '';
                sel.disabled = false;
                return;
            }
            var me = auth.getUser();
            var users = admin.getActivePMs();
            // If the cache hasn't loaded yet, kick off a refresh and at least seed self
            if (!users.length && me) {
                users = [{ id: me.id, name: me.name, role: me.role, active: true }];
                if (admin.refreshUsers) admin.refreshUsers();
            }
            var html = '<option value="">-- Select PM --</option>';
            users.forEach(function(u) {
                html += '<option value="' + u.id + '" data-name="' + escapeHTML(u.name) + '">' +
                        escapeHTML(u.name) + (u.role === 'admin' ? ' (admin)' : '') + '</option>';
            });
            sel.innerHTML = html;

            if (auth.isAdmin()) {
                sel.disabled = false;
                sel.value = me ? String(me.id) : '';
            } else {
                // PMs always own jobs they create — lock to self
                sel.value = me ? String(me.id) : '';
                sel.disabled = true;
            }
        }

        function saveJob() {
            const title = document.getElementById('jobTitle').value.trim();
            if (!title) { alert('Enter a job name'); return; }
            // Require a job number: S#### (Service) or RV#### (Renovation), editable.
            var _jnRaw = (document.getElementById('jobNumber').value || '');
            var jobNum = (window.p86JobFinalize && window.p86JobFinalize.normalizeNumber)
                ? window.p86JobFinalize.normalizeNumber(_jnRaw)
                : (/^(S|RV)\d{1,6}$/i.test(_jnRaw.trim()) ? _jnRaw.trim().toUpperCase() : null);
            if (!jobNum) { alert('Enter a valid job number: S#### (Service) or RV#### (Renovation).'); document.getElementById('jobNumber').focus(); return; }
            const pmSelect = document.getElementById('jobPM');
            const pmOpt = pmSelect.options[pmSelect.selectedIndex];
            const pmName = (pmOpt && pmOpt.dataset && pmOpt.dataset.name) ? pmOpt.dataset.name : pmSelect.value;
            const ownerIdRaw = parseInt(pmSelect.value, 10);
            // Read the notify checkbox if present (added by addJobModal markup).
            // Defaults ON for new jobs (the new owner deserves an email) but
            // the user can uncheck before saving.
            var notifyEl = document.getElementById('jobNotifyOwner');
            var notify = notifyEl ? !!notifyEl.checked : true;
            // clientId is the structured link to the clients-directory row
            // (used by the weather geocoder + future client-driven workflow).
            // Free-text client name stays as a back-compat display field;
            // both can coexist when the user picks from the directory and
            // the picker auto-fills the name. Empty string means unlinked.
            var pickedClientId = (document.getElementById('jobClientId') || {}).value || '';
            const job = {
                id: 'j' + Date.now(),
                jobNumber: jobNum,
                title: title,
                client: document.getElementById('jobClient').value.trim(),
                clientId: pickedClientId || null,
                pm: pmName,
                owner_id: isNaN(ownerIdRaw) ? null : ownerIdRaw,
                jobType: document.getElementById('jobType').value,
                workType: document.getElementById('jobWorkType').value,
                market: document.getElementById('jobMarket').value,
                status: document.getElementById('jobStatus').value,
                contractAmount: parseFloat(document.getElementById('jobContractAmount').value) || 0,
                estimatedCosts: parseFloat(document.getElementById('jobEstimatedCosts').value) || 0,
                targetMarginPct: parseFloat(document.getElementById('jobTargetMargin').value) || 50,
                totalProductionDays: parseInt(document.getElementById('jobTotalProductionDays') ? document.getElementById('jobTotalProductionDays').value : '', 10) || 0,
                notes: document.getElementById('jobNotes').value.trim(),
                pctComplete: 0,
                invoicedToDate: 0,
                // _notify is a transient per-save flag the bulk-save route
                // reads to decide whether to email the owner. Stripped from
                // the persisted blob server-side; never round-trips.
                _notify: notify,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            };
            appData.jobs.push(job);
            saveData();
            closeModal('addJobModal');
            renderJobsMain();
        }

        // Map-as-job-page: opening a job renders the job detail (so workspace-layout mounts the
        // job subnav into the LEFT app sidebar — the "normal" sidebar) and opens the Site Plan
        // map overlay beside it (the overlay starts at the sidebar's right edge, not over it).
        function editJob(jobId) {
            appState.currentJobId = jobId;
            renderJobDetail(jobId);
            var _mv = document.getElementById('jobs-main-view'); if (_mv) _mv.style.display = 'none';
            var _dv = document.getElementById('jobs-job-detail-view'); if (_dv) _dv.style.display = 'block';
            if (typeof window.p86NavSave === 'function') window.p86NavSave();
            // Jobs now land on the full-width Overview (renderJobDetail →
            // switchJobSubTab). The node-graph map is a dedicated "Site Map"
            // tab, opened on demand — no longer auto-opened over the page.
        }

        // The job-level side effects renderJobDetail performs, WITHOUT building the classic
        // DOM — so the map view (left card + Inspector) reads accurate numbers.
        function prepJobForView(jobId) {
            const job = appData.jobs.find(j => j.id === jobId);
            if (!job || job._canEdit === false) return;
            recalcSubCosts(jobId, { force: true });
            if (!job.pctCompleteManual) {
                const hasPhases = appData.phases.filter(p => p.jobId === jobId).length > 0;
                const hasBuildings = appData.buildings.filter(b => b.jobId === jobId).length > 0;
                if (hasPhases || hasBuildings) job.pctComplete = Math.round(calcJobPctComplete(jobId) * 10) / 10;
            }
            saveData();
        }

        // The classic card detail page — now an "Edit details" editor reached from the map
        // (job meta: name / client / address / dates / notes). Closes the map overlay if open.
        function openJobClassicEditor(jobId) {
            appState.currentJobId = jobId;
            renderJobDetail(jobId);
            document.getElementById('jobs-main-view').style.display = 'none';
            document.getElementById('jobs-job-detail-view').style.display = 'block';
            const ng = document.getElementById('nodeGraphTab');
            if (ng && ng.classList.contains('active')) {
                if (typeof window.closeNodeGraph === 'function') window.closeNodeGraph();
                else ng.classList.remove('active');
            }
            if (typeof window.p86NavSave === 'function') window.p86NavSave();
        }
        window.openJobClassicEditor = openJobClassicEditor;

        function backToJobsMain() {
            // If the node graph is up as a fullscreen overlay, save +
            // close it before showing the Jobs list. The graph is a
            // position:fixed sibling, so without explicitly removing
            // its .active class it would float over the list.
            var ngTab = document.getElementById('nodeGraphTab');
            if (ngTab && ngTab.classList.contains('active')) {
                if (typeof NG !== 'undefined' && NG.saveGraph) {
                    try { NG.saveGraph(); } catch (e) { /* defensive */ }
                }
                ngTab.classList.remove('active');
            }
            document.getElementById('jobs-main-view').style.display = 'block';
            document.getElementById('jobs-job-detail-view').style.display = 'none';
            appState.currentJobId = null;
            renderJobsMain();
            // Sync nav-state + URL back to /jobs. backToJobsMain isn't
            // router-wrapped, so without this the address bar keeps
            // /jobs/:id while the LIST is on screen — and a refresh (URL
            // wins over nav-state) drags the user back into the job they
            // just left.
            if (typeof window.p86NavSave === 'function') window.p86NavSave();
            if (window.p86Router && typeof window.p86Router.sync === 'function') window.p86Router.sync();
        }
        // Exposed so the Site Plan's Back button + the sticky-header
        // "← Back to Jobs" go to the actual jobs LIST (not the retired
        // classic overview that used to sit under the map overlay).
        window.backToJobsMain = backToJobsMain;

        function archiveCurrentJob() {
            const job = appData.jobs.find(j => j.id === appState.currentJobId);
            if (!job) return;
            if (job.status === 'Archived') {
                // Unarchive — no confirm needed, it's a recoverable toggle
                job.status = 'Completed';
                job.updatedAt = new Date().toISOString();
                saveData();
                renderJobDetail(job.id);
                return;
            }
            var go = (typeof window.p86Confirm === 'function')
              ? window.p86Confirm({
                  title: 'Archive job',
                  message: 'Archive "' + (job.title || 'this job') + '"? It will be hidden from the active list.',
                  confirmLabel: 'Archive'
                })
              : Promise.resolve(window.confirm('Archive this job?'));
            go.then(function(ok) {
              if (!ok) return;
              job.status = 'Archived';
              job.archivedAt = new Date().toISOString();
              job.updatedAt = new Date().toISOString();
              saveData();
              renderJobDetail(job.id);
            });
        }

        function deleteCurrentJob() {
            const jobId = appState.currentJobId;
            const job = appData.jobs.find(j => j.id === jobId);
            if (!job) return;
            var go = (typeof window.p86Confirm === 'function')
              ? window.p86Confirm({
                  title: 'Delete job permanently',
                  message: 'Permanently delete "' + (job.title || 'this job') + '" and all its buildings, phases, subs, and change orders?\n\nThis cannot be undone.',
                  confirmLabel: 'Delete forever',
                  danger: true
                })
              : Promise.resolve(window.confirm('Permanently delete this job?'));
            go.then(function(ok) {
              if (!ok) return;
              _deleteJobConfirmed(jobId);
            });
        }
        function _deleteJobConfirmed(jobId) {
            // Remove all related data locally
            appData.buildings = appData.buildings.filter(b => b.jobId !== jobId);
            appData.phases = appData.phases.filter(p => p.jobId !== jobId);
            appData.subs = appData.subs.filter(s => s.jobId !== jobId);
            appData.changeOrders = appData.changeOrders.filter(c => c.jobId !== jobId);
            appData.purchaseOrders = (appData.purchaseOrders || []).filter(p => p.jobId !== jobId);
            appData.invoices = (appData.invoices || []).filter(i => i.jobId !== jobId);
            appData.jobs = appData.jobs.filter(j => j.id !== jobId);
            // Remove workspace data
            var allWs = safeLoadJSON('p86-workspaces', {});
            delete allWs[jobId];
            localStorage.setItem('p86-workspaces', JSON.stringify(allWs));
            // Persist locally + push to server. The bulk-save endpoint only
            // upserts present jobs, so we also need an explicit DELETE
            // /api/jobs/:id call — without this the server keeps the job
            // and it reappears on the next page reload.
            saveData();
            if (window.p86Api && window.p86Api.isAuthenticated()) {
                window.p86Api.jobs.remove(jobId).catch(function(err) {
                    console.warn('Server delete failed for ' + jobId + ':', err.message);
                });
            }
            backToJobsMain();
        }

        // Edit the Job Information card. Layout-agnostic: instead of rebuilding
        // a grid, it swaps each value cell (#job-info-*) in place into an input,
        // and on save re-runs renderJobDetail (which repopulates those same ids).
        // Read-only-gated the same way every other job input is — a job with
        // _canEdit === false never enters edit mode (and the button is disabled
        // by the .read-only-mode CSS + applyReadOnlyButtonGuard).
        function toggleEditJobInfo() {
            const jobId = appState.currentJobId;
            const job = appData.jobs.find(j => j.id === jobId);
            if (!job) return;
            const btn = document.getElementById('edit-job-info-btn');
            if (!btn) return;
            if (job._canEdit === false) return; // gate: no editing assigned-away jobs
            const isEditing = btn.getAttribute('data-editing') === '1';

            const IST = 'width:100%;box-sizing:border-box;background:var(--input-bg,#0f111a);color:var(--text);border:1px solid var(--border,#2a2a32);border-radius:6px;padding:5px 7px;font-size:13px;';
            const SST = 'box-sizing:border-box;background:var(--input-bg,#0f111a);color:var(--text);border:1px solid var(--border,#2a2a32);border-radius:6px;padding:4px 6px;font-size:12px;';
            const opts = (arr, cur) => arr.map(v => '<option' + (v === cur ? ' selected' : '') + '>' + escapeHTML(v) + '</option>').join('');

            if (isEditing) {
                // Save — read inputs defensively (a cell may be absent on older
                // cached markup) and write back.
                const gv = (id) => { const e = document.getElementById(id); return e ? e.value : null; };
                let v;
                if ((v = gv('edit-jobNumber')) !== null) job.jobNumber = v.trim();
                if ((v = gv('edit-jobTitle')) !== null) job.title = v.trim();
                if ((v = gv('edit-jobClient')) !== null) job.client = v.trim();
                if ((v = gv('edit-jobPM')) !== null) job.pm = v;
                if ((v = gv('edit-jobType')) !== null) job.jobType = v;
                if ((v = gv('edit-jobWorkType')) !== null) job.workType = v;
                if ((v = gv('edit-jobMarket')) !== null) job.market = v;
                if ((v = gv('edit-jobContract')) !== null) job.contractAmount = parseFloat(v) || 0;
                if ((v = gv('edit-jobEstCosts')) !== null) job.estimatedCosts = parseFloat(v) || 0;
                if ((v = gv('edit-jobMargin')) !== null) job.targetMarginPct = parseFloat(v) || 50;
                // Schedule page reads totalProductionDays for daily-revenue math.
                if ((v = gv('edit-jobProductionDays')) !== null) job.totalProductionDays = parseInt(v, 10) || 0;
                if ((v = gv('edit-jobStatus')) !== null) job.status = v;
                if ((v = gv('edit-jobNotes')) !== null) job.notes = v.trim();
                job.updatedAt = new Date().toISOString();
                saveData();
                btn.setAttribute('data-editing', '0');
                btn.innerHTML = '&#9998; Edit';
                renderJobDetail(jobId); // repopulates #job-info-* cells → restores display
            } else {
                // Enter edit mode — swap each value cell into an input/select.
                const FIELDS = {
                    'job-info-title':     () => '<input id="edit-jobTitle" type="text" value="' + escapeHTML(job.title || '') + '" style="' + IST + '">',
                    'job-info-number':    () => '<input id="edit-jobNumber" type="text" value="' + escapeHTML(job.jobNumber || '') + '" style="' + IST + '">',
                    'job-info-client':    () => '<input id="edit-jobClient" type="text" value="' + escapeHTML(job.client || '') + '" style="' + IST + '">',
                    'job-info-pm':        () => '<select id="edit-jobPM" style="' + IST + '">' + opts(['John', 'Noah', 'Henry'], job.pm) + '</select>',
                    'job-info-type':      () => '<select id="edit-jobType" style="' + IST + '">' + opts(['Service', 'Renovation', 'Work Order'], job.jobType) + '</select>',
                    'job-info-worktype':  () => '<input id="edit-jobWorkType" type="text" value="' + escapeHTML(job.workType || '') + '" style="' + IST + '">',
                    'job-info-market':    () => '<select id="edit-jobMarket" style="' + IST + '">' + opts(['Tampa', 'Orlando'], job.market) + '</select>',
                    'job-info-contract':  () => '<input id="edit-jobContract" type="number" step="0.01" value="' + (job.contractAmount || 0) + '" style="' + IST + '">',
                    'job-info-estcosts':  () => '<input id="edit-jobEstCosts" type="number" step="0.01" value="' + (job.estimatedCosts || 0) + '" style="' + IST + '">',
                    'job-info-margin':    () => '<input id="edit-jobMargin" type="number" value="' + (job.targetMarginPct || 50) + '" style="' + IST + '">',
                    'job-info-prod-days': () => '<input id="edit-jobProductionDays" type="number" value="' + (job.totalProductionDays || '') + '" style="' + IST + '">',
                    'job-info-status':    () => '<select id="edit-jobStatus" style="' + SST + '">' + opts(['New', 'Backlog', 'In Progress', 'On Hold', 'Completed', 'Archived'], job.status) + '</select>',
                    'job-info-notes':     () => '<textarea id="edit-jobNotes" rows="3" style="' + IST + 'resize:vertical;">' + escapeHTML(job.notes || '') + '</textarea>'
                };
                Object.keys(FIELDS).forEach((cellId) => {
                    const el = document.getElementById(cellId);
                    if (el) el.innerHTML = FIELDS[cellId]();
                });
                btn.setAttribute('data-editing', '1');
                btn.innerHTML = '&#x1F4BE; Save';
            }
        }

        // Resolve a job's PM display name from owner_id via the users cache,
        // falling back to the legacy job.pm string for old jobs / offline mode.
        function getJobOwnerName(job) {
            if (!job) return '—';
            if (window.p86Admin && window.p86Admin.findUserById) {
                var u = window.p86Admin.findUserById(job.owner_id);
                if (u && u.name) return u.name;
            }
            return job.pm || '—';
        }

        // Back-link navigation from a job to its source lead / estimate
        // (the "← From lead / estimate" chips on the job detail header).
        function openLeadFromJob(leadId) {
            if (typeof window.switchTab === 'function') window.switchTab('leads');
            setTimeout(function () {
                if (typeof window.openEditLeadModal === 'function') window.openEditLeadModal(leadId);
            }, 200);
        }
        function openEstimateFromJob(estimateId) {
            if (typeof window.switchTab === 'function') window.switchTab('estimates');
            setTimeout(function () {
                if (typeof window.editEstimate === 'function') window.editEstimate(estimateId);
            }, 200);
        }
        window.openLeadFromJob = openLeadFromJob;
        window.openEstimateFromJob = openEstimateFromJob;

        // ── Attach an estimate to an existing (lead-only) job ──────────────
        // The estimate is the source of truth for estimated costs, so linking
        // re-seeds the job's Contract (proposal total) + Estimated Costs (base
        // cost) and carries the workspace. Backfills a hollow lead-only job.
        function _jobEstTotals(est) { try { return (window.computeEstimateTotals ? window.computeEstimateTotals(est) : {}) || {}; } catch (e) { return {}; } }
        function _jobMoney(n) { return Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

        async function _doLinkEstimateToJob(jobId, est) {
            try {
                var t = _jobEstTotals(est);
                var contractAmount = (typeof t.proposalTotal === 'number') ? t.proposalTotal : undefined;
                var estimatedCosts = (typeof t.baseCost === 'number') ? t.baseCost : undefined;
                var workbook = null;
                if (typeof window.p86InheritWorkbookFromEstimate === 'function') {
                    var inh = await window.p86InheritWorkbookFromEstimate(est);
                    if (inh && inh.workbook) workbook = inh.workbook;
                }
                await window.p86Api.jobs.linkEstimate(jobId, { estimate_id: est.id, contractAmount: contractAmount, estimatedCosts: estimatedCosts, workbook: workbook });
                var job = appData.jobs.find(function (j) { return j.id === jobId; });
                if (job) {
                    job.estimate_id = est.id;
                    if (contractAmount != null) job.contractAmount = contractAmount;
                    if (estimatedCosts != null) job.estimatedCosts = estimatedCosts;
                    if (workbook) job.workbook = workbook;
                    if (!job.lead_id && est.lead_id) job.lead_id = est.lead_id;
                }
                est.job_id = jobId;
                if (typeof window.p86Toast === 'function') window.p86Toast('Estimate linked — contract + estimated costs updated from the estimate.');
                if (typeof renderJobDetail === 'function') renderJobDetail(jobId);
            } catch (err) {
                alert('Could not link the estimate: ' + ((err && err.message) || 'unknown error'));
            }
        }

        function addEstimateToJob(jobId) {
            var job = appData.jobs.find(function (j) { return j.id === jobId; });
            if (!job) return;
            var leadId = job.lead_id || null;
            var ests = ((window.appData && window.appData.estimates) || []).filter(function (e) {
                return leadId && e.lead_id === leadId && (!e.job_id || e.job_id === jobId);
            });
            function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
            var ov = document.createElement('div');
            ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:99990;display:flex;align-items:center;justify-content:center;padding:20px;';
            var rows = ests.map(function (e, i) {
                var t = _jobEstTotals(e);
                var nm = e.name || e.title || ('Estimate ' + String(e.id).slice(0, 8));
                return '<button data-link="' + i + '" style="display:block;width:100%;text-align:left;margin:6px 0;padding:12px 14px;border:1px solid var(--border,#333);border-radius:8px;background:var(--bg,#0a0a14);color:var(--text,#fff);cursor:pointer;">' +
                    '<div style="font-weight:600;">' + esc(nm) + '</div>' +
                    '<div style="font-size:12px;color:var(--text-muted,#9aa);margin-top:3px;">Contract $' + _jobMoney(t.proposalTotal) + ' &middot; Est. cost $' + _jobMoney(t.baseCost) + '</div>' +
                    '</button>';
            }).join('');
            var card = document.createElement('div');
            card.style.cssText = 'background:var(--card-bg,#141419);border:1px solid var(--border,#333);border-radius:12px;max-width:520px;width:100%;max-height:80vh;overflow:auto;padding:18px;';
            card.innerHTML =
                '<div style="font-size:15px;font-weight:700;margin-bottom:4px;">Add an estimate to this job</div>' +
                '<div style="font-size:12px;color:var(--text-muted,#9aa);margin-bottom:10px;">The estimate is the source of truth for estimated costs — linking sets the job’s Contract + Estimated Costs and carries the workspace.</div>' +
                (ests.length
                    ? ('<div style="font-size:12px;font-weight:600;color:var(--text-muted,#9aa);margin:8px 0 2px;">Link an existing estimate' + (leadId ? ' on this lead' : '') + '</div>' + rows)
                    : '<div style="font-size:12px;color:var(--text-muted,#9aa);margin:6px 0;">No estimates on this job’s lead yet.</div>') +
                (leadId ? '<button data-create="1" style="display:block;width:100%;margin-top:10px;padding:11px 14px;border:1px dashed var(--border,#555);border-radius:8px;background:transparent;color:var(--blue,#4f8cff);cursor:pointer;">+ New estimate &mdash; opens the lead to build it</button>' : '') +
                '<button data-cancel="1" style="margin-top:10px;padding:8px 14px;border:1px solid var(--border,#333);border-radius:8px;background:transparent;color:var(--text-muted,#9aa);cursor:pointer;">Cancel</button>';
            ov.appendChild(card);
            ov.addEventListener('click', function (ev) {
                var b = ev.target.closest && ev.target.closest('[data-link],[data-create],[data-cancel]');
                if (!b && ev.target !== ov) return;
                var doClose = function () { if (ov.parentNode) ov.parentNode.removeChild(ov); };
                if (!b || b.getAttribute('data-cancel')) { doClose(); return; }
                if (b.getAttribute('data-create')) {
                    doClose();
                    // Slice A: hop to the lead to build a fresh estimate, then come
                    // back and Link it. (Slice B auto-links + live-syncs.)
                    openLeadFromJob(leadId);
                    return;
                }
                var est = ests[Number(b.getAttribute('data-link'))];
                doClose();
                if (est) _doLinkEstimateToJob(jobId, est);
            });
            document.body.appendChild(ov);
        }
        window.addEstimateToJob = addEstimateToJob;

        // ── Job sidebar sections: Details + Estimates ─────────────────────
        // Surfaced as their own RIGHT_TABS panels (workspace-layout.js). The
        // ESTIMATE is the source of truth for Contract price + Estimated cost —
        // both are pulled from the linked estimate (computeEstimateTotals →
        // proposalTotal/baseCost via linkEstimate) and are read-only here.
        function _jdStyles() {
            if (document.getElementById('p86-jd-styles')) return;
            var s = document.createElement('style'); s.id = 'p86-jd-styles';
            s.textContent =
              '.jd-sec{padding:16px 18px;max-width:680px;}' +
              '.jd-h{display:flex;align-items:center;gap:8px;font-size:16px;font-weight:700;color:var(--text,#e9ecf5);margin-bottom:4px;}' +
              '.jd-h svg{width:18px;height:18px;}' +
              '.jd-h2{font-size:11px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;color:var(--text-dim,#8aa0c0);margin:16px 0 6px;}' +
              '.jd-sub{font-size:12.5px;color:var(--text-dim,#8aa0c0);margin-bottom:14px;line-height:1.5;}' +
              '.jd-cost{background:var(--surface,rgba(255,255,255,.05));border:1px solid var(--border,rgba(255,255,255,.1));border-radius:12px;padding:13px 15px;margin-bottom:16px;}' +
              '.jd-cost-h{font-size:11px;font-weight:700;letter-spacing:.3px;text-transform:uppercase;color:var(--text-dim,#8aa0c0);margin-bottom:9px;}' +
              '.jd-cost-h em{color:#34d399;font-style:normal;text-transform:none;letter-spacing:0;}' +
              '.jd-cost-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;}' +
              '.jd-cost-grid label{display:block;font-size:10px;text-transform:uppercase;letter-spacing:.4px;color:var(--text-dim,#8aa0c0);margin-bottom:2px;}' +
              '.jd-cost-grid b{font-family:ui-monospace,Menlo,monospace;font-size:18px;color:var(--text,#e9ecf5);}' +
              '.jd-link{margin-top:11px;background:none;border:none;color:#4f8cff;font-size:12.5px;font-weight:600;cursor:pointer;padding:0;}' +
              '.jd-link:hover{text-decoration:underline;}' +
              '.jd-grid{display:grid;grid-template-columns:1fr 1fr;gap:11px 14px;}' +
              '.jd-fld{display:flex;flex-direction:column;gap:4px;}.jd-fld.jd-full{grid-column:1/-1;margin-top:11px;}' +
              '.jd-fld>span{font-size:10.5px;font-weight:600;letter-spacing:.3px;text-transform:uppercase;color:var(--text-dim,#8aa0c0);}' +
              '.jd-fld input,.jd-fld textarea{background:var(--input-bg,rgba(0,0,0,.25));border:1px solid var(--border,rgba(255,255,255,.12));border-radius:8px;color:var(--text,#e9ecf5);font-size:13px;padding:8px 10px;font-family:inherit;}' +
              '.jd-fld input:focus,.jd-fld textarea:focus{outline:none;border-color:#4f8cff;}' +
              '.jd-btn{background:var(--surface,rgba(255,255,255,.06));border:1px solid var(--border,rgba(255,255,255,.14));border-radius:9px;color:var(--text,#e9ecf5);font-size:13px;font-weight:600;padding:9px 14px;cursor:pointer;display:inline-flex;align-items:center;gap:7px;}' +
              '.jd-btn svg{width:15px;height:15px;}.jd-btn:hover{border-color:#4f8cff;}' +
              '.jd-btn-primary{background:#4f8cff;border-color:#4f8cff;color:#fff;margin-top:16px;}.jd-btn-primary:hover{background:#3d7bef;}' +
              '.jd-est{border:1px solid var(--border,rgba(255,255,255,.1));border-radius:11px;padding:12px 14px;margin-bottom:9px;cursor:pointer;}' +
              '.jd-est:hover{border-color:#4f8cff;}' +
              '.jd-est-primary{background:var(--surface,rgba(255,255,255,.05));border-color:rgba(52,211,153,.35);}' +
              '.jd-est-top{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;}' +
              '.jd-est-nm{font-size:14px;font-weight:600;color:var(--text,#e9ecf5);}' +
              '.jd-est-badge{font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:#34d399;background:rgba(52,211,153,.14);border-radius:999px;padding:3px 9px;}' +
              '.jd-est-nums{display:flex;gap:22px;}' +
              '.jd-est-nums label{display:block;font-size:9.5px;text-transform:uppercase;letter-spacing:.4px;color:var(--text-dim,#8aa0c0);}' +
              '.jd-est-nums b{font-family:ui-monospace,Menlo,monospace;font-size:15px;color:var(--text,#e9ecf5);}' +
              '.jd-est-act{margin-top:10px;}' +
              '.jd-est-none{font-size:13px;color:var(--text-dim,#8aa0c0);border:1px dashed var(--border,rgba(255,255,255,.14));border-radius:10px;padding:14px;text-align:center;}' +
              '.jd-backlead{margin:0 0 14px;}' +
              '.jd-saved{color:#34d399;font-size:12.5px;margin-top:10px;}.jd-empty{padding:24px;color:var(--text-dim,#8aa0c0);}';
            document.head.appendChild(s);
        }
        function _ensureJobSectionPanel(id) {
            var panel = document.getElementById(id);
            if (!panel) {
                var rc = document.getElementById('wsRightContent');
                if (!rc) return null;
                panel = document.createElement('div');
                panel.id = id;
                panel.className = 'sub-tab-content-job';
                rc.appendChild(panel);
            }
            var rcEl = document.getElementById('wsRightContent');
            if (rcEl) {
                Array.prototype.forEach.call(rcEl.children, function (c) {
                    if (c.classList.contains('ws-job-info-details')) return;
                    c.style.display = c === panel ? 'block' : 'none';
                });
            } else { panel.style.display = 'block'; }
            return panel;
        }
        function _jdEsc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
        function _jdIco(n) { return (typeof window.p86Icon === 'function') ? window.p86Icon(n) : ''; }
        function _jdGotoSection(id) { var b = document.querySelector('.ws-right-tab[data-panel="' + id + '"]'); if (b) b.click(); }

        function renderJobEstimates(jobId) {
            _jdStyles();
            var panel = _ensureJobSectionPanel('job-estimates');
            if (!panel) return;
            var job = appData.jobs.find(function (j) { return j.id === jobId; });
            if (!job) { panel.innerHTML = '<div class="jd-empty">No job loaded.</div>'; return; }
            var ests = (window.appData && window.appData.estimates) || [];
            var linked = job.estimate_id ? ests.find(function (e) { return e.id === job.estimate_id; }) : null;
            var leadEsts = job.lead_id ? ests.filter(function (e) { return e.lead_id === job.lead_id && (!linked || e.id !== linked.id); }) : [];
            var h = '<div class="jd-sec"><div class="jd-h">' + _jdIco('estimates') + ' Estimates</div>' +
                '<div class="jd-sub">The estimate is the <b>source of truth</b> for this job’s Contract price and Estimated cost. Linking an estimate — or editing it — updates the job automatically.</div>';
            if (linked) {
                var t = _jobEstTotals(linked), nm = linked.name || linked.title || ('Estimate ' + String(linked.id).slice(0, 8));
                h += '<div class="jd-est jd-est-primary" data-open="' + _jdEsc(linked.id) + '">' +
                    '<div class="jd-est-top"><span class="jd-est-nm">' + _jdEsc(nm) + '</span><span class="jd-est-badge">Source of truth</span></div>' +
                    '<div class="jd-est-nums"><span><label>Contract</label><b>$' + _jobMoney(t.proposalTotal) + '</b></span><span><label>Est. cost</label><b>$' + _jobMoney(t.baseCost) + '</b></span></div>' +
                    '<div class="jd-est-act"><button class="jd-btn" data-open="' + _jdEsc(linked.id) + '">Open &amp; edit estimate</button></div></div>';
            } else {
                h += '<div class="jd-est-none">No estimate linked yet — Contract + Estimated Cost stay $0 until you link one.</div>';
            }
            h += '<button class="jd-btn jd-btn-primary" data-add="1">' + _jdIco('plus') + ' Add / link estimate</button>';
            if (leadEsts.length) {
                h += '<div class="jd-h2">Other estimates on this lead</div>';
                leadEsts.forEach(function (e) {
                    var t2 = _jobEstTotals(e), nm2 = e.name || e.title || ('Estimate ' + String(e.id).slice(0, 8));
                    h += '<div class="jd-est" data-open="' + _jdEsc(e.id) + '"><div class="jd-est-top"><span class="jd-est-nm">' + _jdEsc(nm2) + '</span></div>' +
                        '<div class="jd-est-nums"><span><label>Contract</label><b>$' + _jobMoney(t2.proposalTotal) + '</b></span><span><label>Est. cost</label><b>$' + _jobMoney(t2.baseCost) + '</b></span></div></div>';
                });
            }
            h += '</div>';
            panel.innerHTML = h;
            panel.onclick = function (ev) {
                var add = ev.target.closest && ev.target.closest('[data-add]');
                if (add) { if (window.addEstimateToJob) window.addEstimateToJob(jobId); return; }
                var op = ev.target.closest && ev.target.closest('[data-open]');
                if (op && window.openEstimateFromJob) window.openEstimateFromJob(op.getAttribute('data-open'));
            };
        }
        window.renderJobEstimates = renderJobEstimates;

        function renderJobDetails(jobId) {
            _jdStyles();
            var panel = _ensureJobSectionPanel('job-details');
            if (!panel) return;
            var job = appData.jobs.find(function (j) { return j.id === jobId; });
            if (!job) { panel.innerHTML = '<div class="jd-empty">No job loaded.</div>'; return; }
            var ro = job._canEdit === false;
            var ests = (window.appData && window.appData.estimates) || [];
            var linked = job.estimate_id ? ests.find(function (e) { return e.id === job.estimate_id; }) : null;
            var t = linked ? _jobEstTotals(linked) : {};
            var contract = (typeof job.contractAmount === 'number') ? job.contractAmount : (t.proposalTotal || 0);
            var estCost = (typeof job.estimatedCosts === 'number') ? job.estimatedCosts : (t.baseCost || 0);
            function fld(label, key, val) {
                return '<label class="jd-fld"><span>' + _jdEsc(label) + '</span><input data-k="' + key + '" type="text" value="' + _jdEsc(val == null ? '' : val) + '"' + (ro ? ' disabled' : '') + '></label>';
            }
            var h = '<div class="jd-sec"><div class="jd-h">' + _jdIco('edit') + ' Job Details</div>';
            if (job.lead_id) h += '<div class="jd-backlead"><button class="jd-btn" data-backlead="' + _jdEsc(job.lead_id) + '">' + _jdIco('leads') + ' Back to lead</button></div>';
            h += '<div class="jd-cost"><div class="jd-cost-h">Contract &amp; cost — <em>from the estimate</em></div>' +
                '<div class="jd-cost-grid"><div><label>Contract price</label><b>$' + _jobMoney(contract) + '</b></div><div><label>Estimated cost</label><b>$' + _jobMoney(estCost) + '</b></div></div>' +
                (linked
                    ? '<button class="jd-link" data-openest="' + _jdEsc(linked.id) + '">Edit on the estimate →</button>'
                    : '<button class="jd-link" data-gotoest="1">No estimate linked — Add one to set these →</button>') +
                '</div>';
            h += '<div class="jd-grid">' +
                fld('Job name', 'title', job.title || job.name) +
                fld('Client', 'client', job.client) +
                fld('PM', 'pm', job.pm) +
                fld('Type', 'type', job.type) +
                fld('Market', 'market', job.market) +
                '</div>';
            h += '<label class="jd-fld jd-full"><span>Address</span>' +
                (window.p86Address ? window.p86Address.fieldsHtml(job, { disabled: ro }) : '<input data-k="address" value="' + _jdEsc(job.address || '') + '"' + (ro ? ' disabled' : '') + '>') + '</label>';
            h += '<label class="jd-fld jd-full"><span>Notes</span><textarea data-k="notes" rows="3"' + (ro ? ' disabled' : '') + '>' + _jdEsc(job.notes || '') + '</textarea></label>';
            if (!ro) h += '<button class="jd-btn jd-btn-primary" data-save="1">Save details</button><span class="jd-saved" style="display:none;"> ✓ Saved</span>';
            h += '</div>';
            panel.innerHTML = h;
            if (window.p86Address && window.p86Address.wire) { try { window.p86Address.wire(panel, job); } catch (e) {} }
            panel.onclick = function (ev) {
                var bl = ev.target.closest && ev.target.closest('[data-backlead]');
                if (bl) { if (window.openLeadFromJob) window.openLeadFromJob(bl.getAttribute('data-backlead')); return; }
                var oe = ev.target.closest && ev.target.closest('[data-openest]');
                if (oe) { if (window.openEstimateFromJob) window.openEstimateFromJob(oe.getAttribute('data-openest')); return; }
                var ge = ev.target.closest && ev.target.closest('[data-gotoest]');
                if (ge) { _jdGotoSection('job-estimates'); return; }
                var sv = ev.target.closest && ev.target.closest('[data-save]');
                if (sv) {
                    panel.querySelectorAll('[data-k]').forEach(function (inp) { job[inp.getAttribute('data-k')] = inp.value; });
                    if (window.p86Address) { var c = window.p86Address.collect(panel); if (c) window.p86Address.apply(job, c); }
                    if (typeof saveData === 'function') saveData(); else if (window.saveData) window.saveData();
                    var s = panel.querySelector('.jd-saved'); if (s) { s.style.display = 'inline'; setTimeout(function () { s.style.display = 'none'; }, 1800); }
                    if (typeof window.refreshHeaderMetrics === 'function') { try { window.refreshHeaderMetrics(); } catch (e) {} }
                }
            };
        }
        window.renderJobDetails = renderJobDetails;

        function renderJobDetail(jobId) {
            const job = appData.jobs.find(j => j.id === jobId);
            if (!job) return;

            // Read-only enforcement: when the current user can't edit this job,
            // toggle a CSS class on the detail container that disables form
            // controls and edit-action buttons, and show the explanatory banner.
            // Also skip auto-calc + saveData below since those would attempt
            // server writes that the user isn't allowed to make.
            const detailEl = document.getElementById('jobs-job-detail-view');
            const readOnly = job._canEdit === false;
            if (detailEl) detailEl.classList.toggle('read-only-mode', readOnly);
            const banner = document.getElementById('job-detail-readonly-banner');
            const bannerMsg = document.getElementById('job-detail-readonly-msg');
            if (banner) banner.style.display = readOnly ? '' : 'none';
            if (bannerMsg && readOnly) {
                bannerMsg.textContent = 'This job is assigned to ' + (job.pm || 'another PM') +
                                         '. You can review the data but changes won’t save.';
            }

            if (!readOnly) {
                // Recalculate sub costs from Subcontractors tab entries.
                // Force-refresh on the detail view because the user landing
                // here is about to look at the dollar columns; we want them
                // accurate even if the list-page memoization marked them as
                // unchanged. The list page (renderJobsTable) uses the cached
                // version for cheap per-row paints.
                recalcSubCosts(jobId, { force: true });

                // Auto-calculate % complete from phases/buildings (unless manual override)
                if (!job.pctCompleteManual) {
                    const hasPhases = appData.phases.filter(p => p.jobId === jobId).length > 0;
                    const hasBuildings = appData.buildings.filter(b => b.jobId === jobId).length > 0;
                    if (hasPhases || hasBuildings) {
                        job.pctComplete = Math.round(calcJobPctComplete(jobId) * 10) / 10;
                    }
                }
                saveData();
            }

            // Defensive: re-apply the read-only button guard after the rest of
            // the detail finishes rendering (workspace-layout.js may rebuild
            // panels asynchronously). setTimeout 0 lets all synchronous
            // sub-renders complete before we walk the DOM.
            if (typeof applyReadOnlyButtonGuard === 'function') {
                setTimeout(applyReadOnlyButtonGuard, 0);
            }

            const w = getJobWIP(jobId);

            // Legacy header + info/summary-card fields. The redesigned overview
            // (renderJobOverview) rebuilds that region, so some of these ids may
            // no longer be in the DOM after the first job is opened in a session.
            // Guard the WHOLE block: a single missing element must not throw and
            // abort renderJobDetail — doing so skipped switchJobSubTab() below,
            // so the subtab content (incl. the RFI/Submittal workflow panel)
            // never rendered and the job detail showed a blank body.
            try {
            document.getElementById('job-detail-title').textContent = (job.jobNumber ? job.jobNumber + ' — ' : '') + job.title;
            // Source back-links: if this job was created from a lead/estimate
            // (Create Job conversion stamps job.lead_id / job.estimate_id), show
            // clickable "← From lead / estimate" chips under the title so the
            // bid trail is navigable both ways. Injected dynamically so no
            // index.html change is needed; hidden when there's no source.
            try {
                var _titleEl = document.getElementById('job-detail-title');
                if (_titleEl && _titleEl.parentNode) {
                    var _srcHost = document.getElementById('job-detail-source-chips');
                    if (!_srcHost) {
                        _srcHost = document.createElement('div');
                        _srcHost.id = 'job-detail-source-chips';
                        _srcHost.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:7px;margin-top:8px;';
                        _titleEl.parentNode.insertBefore(_srcHost, _titleEl.nextSibling);
                    }
                    var _chips = (job.lead_id || job.estimate_id)
                        ? '<span style="font-size:10px;font-weight:700;color:var(--text-dim,#888);text-transform:uppercase;letter-spacing:.5px;">Source</span>'
                        : '';
                    if (job.lead_id) {
                        var _leadsC = (window.p86Leads && window.p86Leads.getCached && window.p86Leads.getCached()) || [];
                        var _ld = _leadsC.find(function (x) { return x.id === job.lead_id; });
                        var _lt = _ld ? (_ld.title || 'lead') : 'lead';
                        _chips += '<button onclick="openLeadFromJob(\'' + escapeHTML(job.lead_id) + '\')" class="badge" style="cursor:pointer;border:none;background:rgba(251,191,36,0.12);color:var(--yellow,#fbbf24);">&larr; From lead: ' + escapeHTML(_lt) + '</button>';
                    }
                    if (job.estimate_id) {
                        var _estC = (window.appData && window.appData.estimates) || [];
                        var _es = _estC.find(function (x) { return x.id === job.estimate_id; });
                        var _en = _es ? (_es.name || _es.title || 'estimate') : 'estimate';
                        _chips += '<button onclick="openEstimateFromJob(\'' + escapeHTML(job.estimate_id) + '\')" class="badge" style="cursor:pointer;border:none;background:rgba(79,140,255,0.14);color:#4f8cff;">&larr; From estimate: ' + escapeHTML(_en) + '</button>';
                    }
                    // No estimate backing the job → its estimated costs aren't
                    // flowing into WIP. Flag it with a one-click "Add estimate"
                    // (the estimate is the source of truth for estimated costs).
                    if (!job.estimate_id) {
                        _chips += '<button onclick="addEstimateToJob(\'' + escapeHTML(job.id) + '\')" class="badge" title="No estimate is backing this job, so estimated costs aren&#39;t flowing into its WIP. Click to attach one." style="cursor:pointer;border:none;background:rgba(239,68,68,0.14);color:var(--red,#ef4444);">&#9888;&#xFE0F; No estimate &mdash; costs not flowing &middot; Add estimate</button>';
                    }
                    _srcHost.innerHTML = _chips;
                    _srcHost.style.display = _chips ? 'flex' : 'none';
                }
            } catch (_eSrc) { /* non-fatal — chip is a convenience */ }
            const detailStatusClass = job.status === 'On Hold' ? 'at-risk' : job.status === 'Completed' ? 'on-track' : job.status === 'Archived' ? 'not-started' : 'on-track';
            document.getElementById('job-detail-status').innerHTML = `<span class="badge ${detailStatusClass}">${escapeHTML(job.status)}</span>`;
            // job-detail-contract used to live in the header meta row but was
            // removed when the header collapsed — Total Income now reads off
            // the chip strip. Guard the access so older HTML caches don't crash.
            const contractEl = document.getElementById('job-detail-contract');
            if (contractEl) contractEl.textContent = `Total Income: ${formatCurrency(w.totalIncome)}`;

            document.getElementById('job-info-number').textContent = job.jobNumber || '—';
            document.getElementById('job-info-title').textContent = job.title;
            document.getElementById('job-info-client').textContent = job.client || '—';
            document.getElementById('job-info-pm').textContent = getJobOwnerName(job);
            document.getElementById('job-info-type').textContent = job.jobType ? (job.jobType + (job.market ? ' - ' + job.market : '')) : '—';
            document.getElementById('job-info-worktype').textContent = job.workType || '—';
            document.getElementById('job-info-market').textContent = job.market || '—';
            document.getElementById('job-info-contract').textContent = formatCurrency(job.contractAmount);
            document.getElementById('job-info-estcosts').textContent = formatCurrency(job.estimatedCosts);
            document.getElementById('job-info-margin').textContent = (job.targetMarginPct || 50) + '%';
            // Production days — read by Schedule page for daily-revenue math.
            var prodDaysCell = document.getElementById('job-info-prod-days');
            if (prodDaysCell) prodDaysCell.textContent = job.totalProductionDays ? (job.totalProductionDays + ' days') : '—';
            const statusClass = job.status === 'On Hold' ? 'at-risk' : job.status === 'Completed' ? 'on-track' : job.status === 'Archived' ? 'not-started' : 'on-track';
            document.getElementById('job-info-status').innerHTML = `<span class="badge ${statusClass}">${escapeHTML(job.status)}</span>`;
            document.getElementById('job-info-notes').textContent = job.notes || '—';
            // Project Address — carried from the lead/estimate at conversion;
            // rendered as a Google-Maps deep link for field reference. Guarded so
            // an older HTML cache (no address cell) can't throw.
            var _jobAddr = [job.street_address, job.city, job.state, job.zip].filter(Boolean).join(', ') || job.address || '';
            var _jobAddrCell = document.getElementById('job-info-address');
            if (_jobAddrCell) {
                var _jobAddrDisp = (_jobAddr && window.p86MapLink && window.p86MapLink.linkHTML) ? window.p86MapLink.linkHTML(_jobAddr, _jobAddr) : escapeHTML(_jobAddr || '—');
                _jobAddrCell.innerHTML = _jobAddrDisp +
                    ' <button onclick="editJobAddress(\'' + escapeHTML(job.id) + '\')" title="Edit address" style="margin-left:8px;cursor:pointer;background:none;border:none;color:var(--accent,#4f8cff);font-size:12px;padding:0;">&#9998; Edit</button>';
            }
            // Explain a $0 estimated cost when the job DOES have an estimate (the
            // lead-only case is already covered by the red "Add estimate" chip).
            var _ecCell = document.getElementById('job-info-estcosts');
            if (_ecCell && !job.estimatedCosts && job.estimate_id) {
                _ecCell.innerHTML = formatCurrency(job.estimatedCosts) + ' <span style="color:var(--text-dim,#888);font-size:11px;">· estimate has no cost basis</span>';
            }
            var _archBtn = document.getElementById('archive-job-btn');
            if (_archBtn) _archBtn.textContent = job.status === 'Archived' ? 'Unarchive' : 'Archive';

            // Summary cards — WIP-based
            const coInfo = w.coIncome > 0 ? `Contract: ${formatCurrency(w.contractIncome)} + CO: ${formatCurrency(w.coIncome)}` : '';
            document.getElementById('job-summary-totalincome').textContent = formatCurrency(w.totalIncome);
            document.getElementById('job-summary-income-breakdown').textContent = coInfo;
            document.getElementById('job-summary-cost').textContent = formatCurrency(w.actualCosts);
            // QuickBooks imported actuals — surfaced under the Actual Costs chip so
            // a QB cost import is visibly reflected on the overview. It reads off
            // its own figure (w.qbActualCosts) and does NOT change the WIP actual
            // above (QB lines flow into that only once attributed to cost nodes).
            var _qbNote = document.getElementById('job-summary-cost-note');
            if (_qbNote) {
                if (w.qbActualCosts > 0) {
                    _qbNote.textContent = 'QuickBooks: ' + formatCurrency(w.qbActualCosts) +
                        ' · ' + w.qbCostLineCount + ' line' + (w.qbCostLineCount === 1 ? '' : 's') +
                        (w.qbCostsAsOf ? ' · as of ' + w.qbCostsAsOf : '');
                    _qbNote.style.display = '';
                } else {
                    _qbNote.textContent = '';
                    _qbNote.style.display = 'none';
                }
            }
            var _accrued = (w.accruedCosts != null) ? w.accruedCosts : getJobAccruedCosts(jobId);
            document.getElementById('job-summary-accrued').textContent = formatCurrency(_accrued);
            document.getElementById('job-summary-accrued-note').textContent = (w.poAccrued > 0) ? 'Open POs + earned/unbilled' : (_accrued > 0 ? 'Earned but unbilled' : '');
            document.getElementById('job-summary-pctcomplete').textContent = w.pctComplete.toFixed(1) + '%';
            document.getElementById('job-summary-revenue').textContent = formatCurrency(w.revenueEarned);
            document.getElementById('job-summary-profit').textContent = formatCurrency(w.displayProfit);
            document.getElementById('job-summary-profit').style.color = w.displayProfit >= 0 ? 'var(--green)' : 'var(--red)';
            const jtdMarginStr = w.displayMargin.toFixed(1) + '%';
            document.getElementById('job-summary-margin').textContent = jtdMarginStr;
            } catch (e) { console.warn('[job detail] legacy field render skipped (missing element):', e && e.message); }

            // Re-render the currently active subtab
            const activeSubTab = document.querySelector('.sub-tab-btn-job.active');
            const activeTabName = activeSubTab ? activeSubTab.getAttribute('data-subtab') : 'job-overview';
            // Each sub-render writes to its own subtab's elements; some
            // legacy elements can be absent after the overview redesign, so
            // isolate each call — one throwing on a missing element must NOT
            // abort the others (or leave the detail body blank).
            try { switchJobSubTab(activeTabName); } catch (e) { console.warn('[job detail] subtab render:', e && e.message); }
            try { renderWipTab(jobId); } catch (e) { console.warn('[job detail] wip render:', e && e.message); }
            try { renderChangeOrders(jobId); } catch (e) { console.warn('[job detail] CO render:', e && e.message); }
            try { renderPurchaseOrders(jobId); } catch (e) { console.warn('[job detail] PO render:', e && e.message); }
            try { renderInvoices(jobId); } catch (e) { console.warn('[job detail] invoices render:', e && e.message); }

            // Refresh sticky header metrics strip
            if (typeof refreshHeaderMetrics === 'function') refreshHeaderMetrics();

            // Kick off cloud sync of the node graph so building cards
            // show real wire data even when localStorage didn't have
            // this job's graph cached. Without this, opening a job on
            // a fresh device showed "PHASES (0)" on every building
            // card until the user opened the workspace once. The
            // re-render only fires if no input is focused (avoids
            // wiping a user's mid-typing value).
            ensureNGCloudSynced(jobId, function() {
                // renderJobOverview internally calls renderJobBuildings
                // (and any other dependent sub-renders) when buildings
                // exist, so this single call refreshes the building
                // cards + the overview chrome. Isolated so a stale/missing
                // element can't throw out of the async callback.
                try { renderJobOverview(jobId); } catch (e) { console.warn('[job detail] overview resync:', e && e.message); }
                try { renderWipTab(jobId); } catch (e) { console.warn('[job detail] wip resync:', e && e.message); }
                if (typeof refreshHeaderMetrics === 'function') refreshHeaderMetrics();
            });
        }

        // Track which jobs already had ensureNGComputed run during this
        // session. The first paint of a job pays the synchronous cost (so
        // the building cards show real wire data immediately); subsequent
        // paints rely on the cached numbers and skip the recompute on the
        // critical path. ensureNGCloudSynced already handles the
        // re-render after async cloud sync if the numbers shift.
        var _ngComputedThisSession = {};
        // Compact Bills (Accounts Payable) summary for the overview dashboard.
        // Same records + fields as the Jobs-hub Bills tab (p86Api.bills.listAll),
        // rendered in the shared PO/Invoices section style. Hidden when the job
        // has no bills. Rows open the shared bill editor.
        function renderJobBillsSummaryInto(host, jobId) {
            if (!host) return;
            var section = document.createElement('div');
            section.style.cssText = 'margin-top:14px;';
            section.id = 'job-overview-bills';
            section.innerHTML = '<div style="font-size:12px;color:var(--text-dim);padding:4px 0;">Loading bills…</div>';
            host.appendChild(section);
            if (!window.p86Api || !window.p86Api.bills || !window.p86Api.bills.listAll) { section.innerHTML = ''; return; }
            window.p86Api.bills.listAll({ job: jobId }).then(function(r) {
                var bills = (r && r.bills) || [];
                if (!bills.length) { section.innerHTML = ''; return; }   // nothing owed yet — don't clutter
                var total = 0, paid = 0;
                bills.forEach(function(b) { var a = parseFloat(b.amount) || 0; total += a; if (b.status === 'paid') paid += a; });
                var rows = bills.map(function(b) {
                    var vendor = b.sub_name || (b.data && b.data.vendor) || '';
                    var due = b.due_date ? String(b.due_date).slice(0, 10) : '';
                    var overdue = b.due_date && b.status !== 'paid' && b.status !== 'void' && new Date(b.due_date).getTime() < Date.now();
                    return '<tr class="overview-row" data-bill-id="' + escapeHTML(String(b.id)) + '" style="cursor:pointer;border-bottom:1px solid var(--overlay-light,rgba(255,255,255,0.04));" title="Click to open bill">' +
                        '<td style="white-space:nowrap;padding:6px 10px;"><strong style="color:var(--text,#fff);font-size:13px;">' + escapeHTML(b.bill_number || '—') + '</strong></td>' +
                        '<td style="padding:6px 10px;font-size:12px;color:var(--text-dim,#aaa);">' + escapeHTML(vendor || '—') + '</td>' +
                        '<td style="padding:6px 10px;font-size:11px;color:var(--text-dim,#888);">' + escapeHTML(b.po_number || '—') + '</td>' +
                        '<td class="num" style="text-align:right;white-space:nowrap;padding:6px 10px;font-family:\'SF Mono\',monospace;font-size:13px;font-weight:600;color:var(--accent);">' + formatCurrency(parseFloat(b.amount) || 0) + '</td>' +
                        '<td style="white-space:nowrap;padding:6px 10px;"><span style="font-size:10px;padding:2px 8px;border-radius:10px;background:rgba(79,140,255,0.1);color:var(--text-dim);font-weight:600;">' + escapeHTML(b.status || 'open') + '</span></td>' +
                        '<td style="white-space:nowrap;padding:6px 10px;font-size:11px;' + (overdue ? 'color:#f87171;font-weight:600;' : 'color:var(--text-dim,#888);') + '">' + escapeHTML(due) + '</td>' +
                    '</tr>';
                }).join('');
                section.innerHTML =
                    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">' +
                        '<h3 style="font-size:13px;margin:0;">&#x1F9FE; Bills (' + bills.length + ')</h3>' +
                        '<div style="font-size:12px;color:var(--text-dim);">Total: <b>' + formatCurrency(total) + '</b> &nbsp; Paid: <b style="color:var(--green);">' + formatCurrency(paid) + '</b> &nbsp; Outstanding: <b style="color:var(--yellow);">' + formatCurrency(total - paid) + '</b></div>' +
                    '</div>' +
                    '<div style="border:1px solid var(--border,#333);border-radius:10px;overflow-x:auto;background:var(--card-bg,#141419);">' +
                        '<table style="width:100%;border-collapse:collapse;table-layout:auto;">' +
                            '<thead style="background:var(--overlay-light,rgba(255,255,255,0.02));border-bottom:1px solid var(--border,#333);"><tr>' +
                                thCell('Bill #', 'left') + thCell('Vendor', 'left') + thCell('PO #', 'left') + thCell('Amount', 'right') + thCell('Status', 'left') + thCell('Due', 'left') +
                            '</tr></thead><tbody>' + rows + '</tbody>' +
                        '</table>' +
                    '</div>';
                section.querySelectorAll('[data-bill-id]').forEach(function(tr) {
                    tr.onclick = function() {
                        var id = tr.getAttribute('data-bill-id');
                        if (window.p86Bills && window.p86Bills.open) window.p86Bills.open(id, function() { renderJobOverview(jobId); });
                    };
                });
            }).catch(function() { section.innerHTML = ''; });
        }

        function renderJobOverview(jobId) {
            const container = document.getElementById('job-overview');
            if (!container) return;
            // Recompute node graph values (job.ngActualCosts, per-phase costs)
            // on the FIRST paint of this job so cards reflect current wires.
            // Subsequent paints defer the recompute via setTimeout(0) so the
            // visible repaint isn't blocked. Pure perf — the user sees the
            // first frame faster; the re-paint runs invisibly off the
            // microtask queue if anything actually shifted.
            if (!_ngComputedThisSession[jobId]) {
                ensureNGComputed(jobId);
                _ngComputedThisSession[jobId] = true;
            } else {
                setTimeout(function() { ensureNGComputed(jobId); }, 0);
            }
            container.innerHTML = '';

            // ── Action icon cluster ──
            // 6 add buttons (Building / Phase / Sub / CO / PO / Invoice)
            // render as a tight row of .header-icon-btn glyphs. Hover
            // tooltips carry the labels. Matches the icon-cluster pattern
            // we ship on the estimate editor (Export / Save / Delete) so
            // a job detail's chrome feels like the same product. Sharing
            // + Link Client still render as full-text buttons below
            // because they're contextual (visible only to admin/owner +
            // depend on link state).
            const btnRow = document.createElement('div');
            btnRow.className = 'jobs-action-row';
            btnRow.innerHTML =
                '<div class="jobs-action-icons">' +
                    '<button class="header-icon-btn" data-p86-icon="buildings" onclick="openAddBuildingToJobModal()" title="Add Building" aria-label="Add Building"></button>' +
                    '<button class="header-icon-btn" data-p86-icon="phases" onclick="openAddPhaseToJobModal()" title="Add Scope" aria-label="Add Scope"></button>' +
                    '<button class="header-icon-btn" data-p86-icon="subs" onclick="openAddSubToJobModal()" title="Add Sub" aria-label="Add Sub"></button>' +
                    '<button class="header-icon-btn" data-p86-icon="add" onclick="openAddChangeOrderModal()" title="Add Change Order" aria-label="Add Change Order"></button>' +
                    '<button class="header-icon-btn" data-p86-icon="briefcase" onclick="openAddPOModal()" title="Add Purchase Order" aria-label="Add Purchase Order"></button>' +
                    '<button class="header-icon-btn" data-p86-icon="banknotes" onclick="openAddInvoiceModal()" title="Add Invoice" aria-label="Add Invoice"></button>' +
                '</div>';

            // Sharing button — visible only to admin or the job owner. Renders
            // a tiny inline indicator with the share count, and opens the
            // existing manage-sharing modal on click.
            var auth = window.p86Auth;
            var me = auth && auth.getUser && auth.getUser();
            var jobObj = appData.jobs.find(function(j) { return j.id === jobId; });
            var canManageSharing = me && jobObj && (me.role === 'admin' || me.id === jobObj.owner_id);
            if (canManageSharing && window.p86Api && window.p86Api.isAuthenticated()) {
                btnRow.insertAdjacentHTML('beforeend',
                    '<button class="ee-btn primary" onclick="openJobShareManager(\'' + escapeHTML(jobId) + '\')" ' +
                    'data-readonly-allowed ' +
                    'id="job-overview-share-btn">&#x1F517; Sharing <span id="job-overview-share-count" style="opacity:0.7;font-size:10px;"></span></button>'
                );
                // Async fetch the share count so the button shows '(n)' if any
                window.p86Api.jobs.listAccess(jobId).then(function(res) {
                    var n = (res.shares || []).length;
                    var countEl = document.getElementById('job-overview-share-count');
                    if (countEl && n > 0) countEl.textContent = '(' + n + ')';
                }).catch(function() { /* ignore — button still works without count */ });
            }
            // ── Link Client button ──
            // Visible when the job either isn't linked to a clients-
            // directory record yet, OR is already linked (so the user can
            // re-pick / unlink). Backfills addresses for weather + future
            // client-driven workflow without making the user re-enter
            // anything. Suggests matches based on the free-text client
            // name when no link exists.
            (function () {
                var btn = document.createElement('button');
                btn.className = 'ee-btn secondary';
                btn.id = 'job-overview-link-client-btn';
                btn.style.cssText = 'margin-left:auto;';
                if (jobObj && jobObj.clientId) {
                    var clients = (window.p86Clients && window.p86Clients.getCached) ? window.p86Clients.getCached() : [];
                    var c = clients.find(function(x) { return x.id === jobObj.clientId; });
                    btn.innerHTML = '&#x1F517; Linked: ' + escapeHTML((c && c.name) || jobObj.client || jobObj.clientId);
                    btn.title = 'Click to relink or unlink the client record.';
                } else {
                    btn.innerHTML = '&#x1F517; Link Client';
                    btn.title = 'Match this job to a clients-directory record so weather + workflow can use the client address.';
                }
                btn.onclick = function() { openJobClientLinkModal(jobId); };
                btnRow.appendChild(btn);
            })();
            container.appendChild(btnRow);

            // ── Dashboard grid ──
            // Two columns: a wide LEFT column for the money/work summary
            // (buildings · scope · POs · COs · bills · subs · invoices) and a
            // narrow RIGHT rail for the compact weather + projects/tasks/files.
            // Collapses to one column on narrow screens. This is the "reads like
            // a summary dashboard" layout.
            (function ensureDashStyle() {
                if (document.getElementById('job-overview-dash-style')) return;
                var st = document.createElement('style');
                st.id = 'job-overview-dash-style';
                st.textContent = '.job-overview-dash{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:16px;align-items:start;}.job-overview-dash>.dash-col{min-width:0;}.job-overview-dash .dash-side{display:flex;flex-direction:column;gap:12px;}@media(max-width:900px){.job-overview-dash{grid-template-columns:1fr;}}';
                document.head.appendChild(st);
            })();
            var dash = document.createElement('div');
            dash.className = 'job-overview-dash';
            var dashMain = document.createElement('div'); dashMain.className = 'dash-col dash-main';
            var dashSide = document.createElement('div'); dashSide.className = 'dash-col dash-side';
            dash.appendChild(dashMain); dash.appendChild(dashSide);
            container.appendChild(dash);

            // ── Weather widget ──
            // 7-day NWS forecast for the job's address. Self-contained:
            // schedule.js owns the fetch + render. We just give it a
            // mount point. Renders muted placeholders if the job has no
            // address yet so the widget never shouts "broken" — it just
            // explains why the data isn't there.
            if (window.p86Weather && typeof window.p86Weather.renderJobWidget === 'function') {
                var wxMount = document.createElement('div');
                wxMount.id = 'job-overview-weather';
                dashSide.appendChild(wxMount);
                window.p86Weather.renderJobWidget(wxMount, jobId, { compact: true, title: 'Weather' });
            }

            // ── Linked Projects panel ──
            // CompanyCam-style photo + walkthrough buckets attached to
            // this job via projects.job_id. Surfaces in the overview so
            // PMs see field photos without diving into My Files.
            if (typeof window.renderLinkedProjectsPanel === 'function') {
                var projWrap = document.createElement('fieldset');
                projWrap.style.cssText = 'border:1px solid var(--border,#333);border-radius:8px;padding:6px 10px 8px;margin:0 0 14px 0;';
                projWrap.innerHTML =
                    '<legend style="font-size:10px;font-weight:700;color:var(--text-dim,#888);text-transform:uppercase;letter-spacing:0.6px;padding:0 5px;">&#x1F4F8; Projects</legend>' +
                    '<div id="job-overview-projects-host"></div>';
                dashSide.appendChild(projWrap);
                var projHost = projWrap.querySelector('#job-overview-projects-host');
                if (projHost) {
                    window.renderLinkedProjectsPanel(projHost, { kind: 'job', id: jobId });
                }
            }

            // ── Tasks panel ──
            // To-dos linked to this job via tasks.entity_type='job'. Lets
            // PMs see/assign open field tasks right from the overview.
            if (window.p86Tasks && typeof window.p86Tasks.mountEntityPanel === 'function') {
                var taskWrap = document.createElement('fieldset');
                taskWrap.style.cssText = 'border:1px solid var(--border,#333);border-radius:8px;padding:6px 10px 8px;margin:0 0 14px 0;';
                taskWrap.innerHTML =
                    '<legend style="font-size:10px;font-weight:700;color:var(--text-dim,#888);text-transform:uppercase;letter-spacing:0.6px;padding:0 5px;">&#x2705; Tasks</legend>' +
                    '<div id="job-overview-tasks-host"></div>';
                dashSide.appendChild(taskWrap);
                var taskHost = taskWrap.querySelector('#job-overview-tasks-host');
                if (taskHost) {
                    var jobLabel = (jobObj && ((jobObj.jobNumber ? jobObj.jobNumber + ' — ' : '') + (jobObj.title || ''))) || ('Job ' + jobId);
                    window.p86Tasks.mountEntityPanel(taskHost, 'job', jobId, jobLabel);
                }
            }

            // ── Files panel ──
            // Explorer-style file system scoped to this job (photos, plans,
            // closeout docs, etc.). Jobs had no file UI before.
            if (window.p86Explorer && typeof window.p86Explorer.mount === 'function') {
                var fileWrap = document.createElement('fieldset');
                fileWrap.style.cssText = 'border:1px solid var(--border,#333);border-radius:8px;padding:6px 10px 8px;margin:0 0 14px 0;';
                fileWrap.innerHTML =
                    '<legend style="font-size:10px;font-weight:700;color:var(--text-dim,#888);text-transform:uppercase;letter-spacing:0.6px;padding:0 5px;">&#x1F4C1; Files</legend>' +
                    '<div id="job-overview-files-host"></div>';
                dashSide.appendChild(fileWrap);
                var fileHost = fileWrap.querySelector('#job-overview-files-host');
                if (fileHost) {
                    window.p86Explorer.mount(fileHost, { entityType: 'job', entityId: String(jobId), canEdit: true, embedded: true });
                }
            }

            // ── Self-heal stuck async widgets (belt-and-suspenders) ──
            // The weather / projects / tasks panels each mount a placeholder and
            // paint on their own fetch. If anything strands the first paint on a
            // superseded node (see the insertAdjacentHTML note below re: the
            // no-buildings branch), the panel sits on "Loading…" forever. Re-mount
            // any panel still showing its loading text once the layout has settled.
            // Guarded on `container` still being the live #job-overview so we never
            // paint a job the user has since navigated away from. No-op (guards
            // fail) once a panel has painted, so healthy jobs pay nothing.
            (function scheduleOverviewHeal() {
                var healJobId = jobId, healContainer = container;
                function heal() {
                    if (document.getElementById('job-overview') !== healContainer || !document.body.contains(healContainer)) return;
                    var wxBody = document.getElementById('schJobWxBody-' + healJobId);
                    if (wxBody && /Loading forecast/i.test(wxBody.textContent || '') && window.p86Weather && window.p86Weather.renderJobWidget) {
                        var wxm = document.getElementById('job-overview-weather');
                        if (wxm) { try { window.p86Weather.renderJobWidget(wxm, healJobId, { compact: true, title: 'Weather' }); } catch (e) {} }
                    }
                    var pjHost = document.getElementById('job-overview-projects-host');
                    if (pjHost && /Loading projects/i.test(pjHost.textContent || '') && typeof window.renderLinkedProjectsPanel === 'function') {
                        try { window.renderLinkedProjectsPanel(pjHost, { kind: 'job', id: healJobId }); } catch (e) {}
                    }
                    var tkHost = document.getElementById('job-overview-tasks-host');
                    if (tkHost && /Loading/i.test(tkHost.textContent || '') && window.p86Tasks && window.p86Tasks.mountEntityPanel) {
                        var jb = appData.jobs.find(function(j) { return j.id === healJobId; });
                        var jl = (jb && ((jb.jobNumber ? jb.jobNumber + ' — ' : '') + (jb.title || ''))) || ('Job ' + healJobId);
                        try { window.p86Tasks.mountEntityPanel(tkHost, 'job', healJobId, jl); } catch (e) {}
                    }
                }
                setTimeout(heal, 1300);
                setTimeout(heal, 3000);
            })();

            // ── Building cards ──
            const buildings = appData.buildings.filter(b => b.jobId === jobId);
            if (buildings.length > 0) {
                const bldgSection = document.createElement('div');
                bldgSection.id = 'job-buildings-content';
                dashMain.appendChild(bldgSection);
                renderJobBuildings(jobId);
            }

            if (buildings.length === 0) {
                // insertAdjacentHTML, NOT innerHTML += : `+=` reparses the whole
                // container and recreates every child, orphaning the async widget
                // mounts (weather / projects / tasks / files) that were appended
                // moments earlier — their in-flight fetches then paint detached
                // nodes and the panels stay stuck on "Loading…". Only jobs with
                // zero buildings hit this branch, which is why it looked random.
                dashMain.insertAdjacentHTML('beforeend', '<div style="text-align:center;padding:30px;color:var(--text-dim);font-size:13px;">No buildings or phases yet. Use the buttons above to get started.</div>');
            }

            // ── Phases summary (grouped, expandable, with node connections) ──
            const jobPhases = appData.phases.filter(p => p.jobId === jobId);
            const phSection = document.createElement('div');
            phSection.style.cssText = 'margin-top:14px;';
            phSection.id = 'job-overview-phases';
            renderOverviewPhasesInto(phSection, jobId, jobPhases);
            dashMain.appendChild(phSection);

            // ── Purchase Orders + Change Orders + Bills (money, server-backed) ──
            // The job_purchase_orders / job_change_orders / job_vendor_bills
            // entities — the same records the dedicated subtabs + Jobs hub use —
            // grouped at the top of the summary right under buildings + scope.
            renderJobPurchaseOrdersInto(dashMain, jobId);
            renderJobChangeOrdersInto(dashMain, jobId);
            renderJobBillsSummaryInto(dashMain, jobId);

            // ── Subcontractors summary (cards with expandable connections) ──
            const jobSubs = appData.subs.filter(s => s.jobId === jobId);
            if (jobSubs.length > 0) {
                const subsSection = document.createElement('div');
                subsSection.style.cssText = 'margin-top:14px;';
                subsSection.id = 'job-overview-subs';
                renderOverviewSubsInto(subsSection, jobId, jobSubs);
                dashMain.appendChild(subsSection);
            }

            // ── Invoices summary ──
            const invs = appData.invoices.filter(i => i.jobId === jobId);
            if (invs.length > 0) {
                const invSection = document.createElement('div');
                invSection.style.cssText = 'margin-top:14px;';
                let invTotalAmt = 0, invTotalPaid = 0;
                invs.forEach(i => { invTotalAmt += i.amount || 0; if (i.status === 'Paid') invTotalPaid += i.amount || 0; });
                const invRows = invs.map(function(i) {
                    const statusColor = i.status === 'Paid' ? 'var(--green)' : i.status === 'Sent' ? 'var(--yellow)' : 'var(--text-dim)';
                    return '<tr class="overview-row" style="cursor:pointer;border-bottom:1px solid var(--overlay-light,rgba(255,255,255,0.04));" onclick="editInvoice(\'' + escapeHTML(i.id) + '\')" title="Click to edit">' +
                        '<td style="white-space:nowrap;padding:6px 10px;"><strong style="color:var(--text,#fff);font-size:13px;">' + escapeHTML(i.invNumber || 'INV') + '</strong></td>' +
                        '<td style="padding:6px 10px;font-size:12px;color:var(--text-dim,#aaa);">' + escapeHTML(i.vendor || '') + '</td>' +
                        '<td style="padding:6px 10px;font-size:11px;color:var(--text-dim,#888);">' + escapeHTML(i.description || '') + '</td>' +
                        '<td class="num" style="text-align:right;white-space:nowrap;padding:6px 10px;font-family:\'SF Mono\',monospace;font-size:13px;font-weight:600;color:var(--accent);">' + formatCurrency(i.amount) + '</td>' +
                        '<td style="white-space:nowrap;padding:6px 10px;font-size:11px;color:var(--text-dim,#888);">' + escapeHTML(i.date || '') + '</td>' +
                        '<td style="white-space:nowrap;padding:6px 10px;font-size:11px;color:var(--text-dim,#888);">' + escapeHTML(i.dueDate || '') + '</td>' +
                        '<td style="white-space:nowrap;padding:6px 10px;"><span style="font-size:10px;padding:2px 8px;border-radius:10px;background:rgba(79,140,255,0.1);color:' + statusColor + ';font-weight:600;">' + escapeHTML(i.status || 'Draft') + '</span></td>' +
                    '</tr>';
                }).join('');
                invSection.innerHTML =
                    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">' +
                        '<h3 style="font-size:13px;margin:0;">&#x1F4B3; Invoices (' + invs.length + ')</h3>' +
                        '<div style="font-size:12px;color:var(--text-dim);">Total: <b>' + formatCurrency(invTotalAmt) + '</b> &nbsp; Paid: <b style="color:var(--green);">' + formatCurrency(invTotalPaid) + '</b> &nbsp; Outstanding: <b style="color:var(--yellow);">' + formatCurrency(invTotalAmt - invTotalPaid) + '</b></div>' +
                    '</div>' +
                    '<div style="border:1px solid var(--border,#333);border-radius:10px;overflow-x:auto;background:var(--card-bg,#141419);">' +
                        '<table style="width:100%;border-collapse:collapse;table-layout:auto;">' +
                            '<thead style="background:var(--overlay-light,rgba(255,255,255,0.02));border-bottom:1px solid var(--border,#333);"><tr>' +
                                thCell('Inv #', 'left') +
                                thCell('Vendor', 'left') +
                                thCell('Description', 'left') +
                                thCell('Amount', 'right') +
                                thCell('Date', 'left') +
                                thCell('Due', 'left') +
                                thCell('Status', 'left') +
                            '</tr></thead>' +
                            '<tbody>' + invRows + '</tbody>' +
                        '</table>' +
                    '</div>';
                dashMain.appendChild(invSection);
            }
        }

        // ==================== WEEKLY SNAPSHOT / CLOSE WEEK ====================
        // Returns a YYYY-MM-DD string for the given Date in America/New_York
        // (business timezone, used for dating all daily snapshots regardless
        // of where the user's browser actually is).
        function dateKeyEST(d) {
            d = d || new Date();
            return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
        }

        // Builds the snapshot blob from current job state. Shared by both daily
        // and weekly capture paths so they record the same fields.
        function buildSnapshotPayload(jobId, dateTag) {
            const job = appData.jobs.find(j => j.id === jobId);
            if (!job) return null;
            ensureNGComputed(jobId);
            const w = getJobWIP(jobId);
            const accrued = getJobAccruedCosts(jobId);
            const buildings = appData.buildings.filter(b => b.jobId === jobId);
            const phases = appData.phases.filter(p => p.jobId === jobId);
            // Change orders are server-backed in appData.jobChangeOrders (keyed
            // job_id). appData.changeOrders is a dead localStorage relic that is
            // always empty, so every snapshot recorded an EMPTY changeOrders
            // detail list. The headline figures were unaffected — getJobWIP takes
            // coIncome from getJobCOTotals, which reads the right store — but the
            // per-CO breakdown captured for history was missing entirely.
            const cos = (appData.jobChangeOrders || []).filter(function (c) {
                return c && c.job_id === jobId && (c.status === 'approved' || c.status === 'applied');
            });
            const legacyCos = (appData.changeOrders || []).filter(c => c.jobId === jobId);
            const subs = appData.subs.filter(s => s.jobId === jobId);
            const pos = (appData.purchaseOrders || []).filter(p => p.jobId === jobId);

            return {
                weekOf: dateTag,
                dateKey: dateTag,
                closedAt: new Date().toISOString(),
                job: {
                    pctComplete: w.pctComplete,
                    totalIncome: w.totalIncome,
                    contractIncome: w.contractIncome,
                    estimatedCosts: w.estimatedCosts,
                    revisedEstCosts: w.revisedEstCosts,
                    actualCosts: w.actualCosts,
                    accrued: accrued,
                    revEarned: w.revenueEarned,
                    invoiced: w.invoiced,
                    coIncome: w.coIncome,
                    grossProfit: w.revisedProfit,
                    backlog: w.backlog
                },
                buildings: buildings.map(function(b) {
                    var bPct = calcBuildingPctComplete(b.id, jobId);
                    var bCost = (b.materials||0)+(b.labor||0)+(b.sub||0)+(b.equipment||0);
                    return { id:b.id, name:b.name, pctComplete:bPct, budget:buildingEffectiveBudget(b, jobId).amount, cost:bCost };
                }),
                phases: phases.map(function(p) {
                    var pCost = (p.materials||0)+(p.labor||0)+(p.sub||0)+(p.equipment||0);
                    return { id:p.id, name:p.phase, pctComplete:p.pctComplete||0, revenue:phaseRevenue(p), cost:pCost, buildingId:p.buildingId };
                }),
                changeOrders: cos.map(function(c) {
                    // No flat income field on a server CO — money comes from its
                    // lines through the shared pricing pipeline, the same one
                    // getJobCOTotals sums, so the detail reconciles to the headline.
                    var sell = 0, cost = 0;
                    try { sell = (typeof coSellAmount === 'function') ? (coSellAmount(c) || 0) : 0; } catch (e) {}
                    try {
                        if (window.p86Pricing) cost = window.p86Pricing.computeForLines(c, c.lines || []).subtotal || 0;
                    } catch (e) {}
                    return { id:c.id, coNumber:c.co_number, income:Math.round(sell*100)/100,
                             estimatedCosts:Math.round(cost*100)/100, pctComplete:0, status:c.status };
                }).concat(legacyCos.map(function(c) {
                    return { id:c.id, coNumber:c.coNumber, income:c.income||0, estimatedCosts:c.estimatedCosts||0, pctComplete:c.pctComplete||0 };
                })),
                subs: subs.map(function(s) {
                    return { id:s.id, name:s.name, contractAmt:s.contractAmt||0, billedToDate:s.billedToDate||0, accruedAmt:s.accruedAmt||0 };
                }),
                purchaseOrders: pos.map(function(p) {
                    return { id:p.id, vendor:p.vendor, amount:p.amount||0, billedToDate:p.billedToDate||0 };
                })
            };
        }

        // Capture (or refresh) today's daily snapshot for a single job. Only
        // snapshots Live jobs unless `force` is true (used by the manual
        // "Capture Now" button on the Metrics tab). Auto-prunes dailySnapshots
        // older than 90 days.
        function captureDailySnapshot(jobId, force) {
            const job = appData.jobs.find(j => j.id === jobId);
            if (!job) return false;
            if (!force && job.liveStatus !== 'live') return false;
            if (!job.dailySnapshots) job.dailySnapshots = [];
            var today = dateKeyEST();
            var payload = buildSnapshotPayload(jobId, today);
            if (!payload) return false;
            var existingIdx = job.dailySnapshots.findIndex(function(s) { return s.dateKey === today; });
            if (existingIdx >= 0) {
                job.dailySnapshots[existingIdx] = payload;
            } else {
                job.dailySnapshots.push(payload);
            }
            // Sort ascending and prune anything older than 90 days
            job.dailySnapshots.sort(function(a, b) { return a.dateKey < b.dateKey ? -1 : 1; });
            var cutoff = new Date();
            cutoff.setDate(cutoff.getDate() - 90);
            var cutoffKey = cutoff.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
            job.dailySnapshots = job.dailySnapshots.filter(function(s) { return s.dateKey >= cutoffKey; });
            return true;
        }

        // Capture daily snapshots for every Live job that's missing today's
        // entry. Saves once at the end if anything was captured. Returns the
        // number of jobs captured.
        function captureDailySnapshotsForAllLiveJobs() {
            var today = dateKeyEST();
            var captured = 0;
            (appData.jobs || []).forEach(function(j) {
                if (j.liveStatus !== 'live') return;
                var has = (j.dailySnapshots || []).some(function(s) { return s.dateKey === today; });
                if (has) return;
                if (captureDailySnapshot(j.id)) captured++;
            });
            if (captured > 0) saveData();
            return captured;
        }

        // Returns ms until next 3 AM America/New_York. Used by the scheduler
        // to fire one snapshot pass per day if the app stays open across
        // 3 AM EST/EDT. NY DST shifts are handled automatically by the
        // toLocaleString conversion — we don't have to track EDT vs EST.
        function msUntilNext3AmEst() {
            var now = new Date();
            // Build a Date that represents "now" in NY timezone as a string,
            // then parse it back. Lose the timezone offset so math is local.
            var nyNowStr = now.toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false });
            var nyNow = new Date(nyNowStr);
            var target = new Date(nyNow);
            target.setHours(3, 0, 5, 0); // 3:00:05 AM, slight buffer past the hour
            if (target <= nyNow) target.setDate(target.getDate() + 1);
            var diffMs = target.getTime() - nyNow.getTime();
            // Floor at 60s to avoid tight loops if the math goes weird
            return Math.max(60000, diffMs);
        }

        // ── Cost-flow accessors (legacy-tolerant) ─────────────────────
        // Phase revenue lives in three generations of fields:
        // asSoldRevenue (current; asSoldPhaseBudget mirrors it), with
        // phaseBudget as the original single field (new saves keep it
        // = asSold + CO income). Legacy rows only carry phaseBudget —
        // read through the chain so pre-rework phases stop rendering $0.
        function phaseRevenue(p) {
            if (!p) return 0;
            // Truthy chain on purpose: legacy rows carry an explicit
            // asSoldRevenue: 0 written by old save paths while the real
            // number sits in asSoldPhaseBudget/phaseBudget (verified on
            // Saddlebrook: {asSoldRevenue:0, asSoldPhaseBudget:5000}).
            // A null-check chain would stop at that dead 0.
            return p.asSoldRevenue || p.asSoldPhaseBudget || p.phaseBudget || 0;
        }
        // A building with no explicit budget derives one from its phases:
        // graph-wired phases (× allocation) plus phases assigned via
        // buildingId that aren't wired. Returns { amount, derived }.
        // A building's budget is the SUM of the phase slices allocated to it —
        // phases are the single source of truth (contract → phases → buildings).
        // A legacy manually-entered `building.budget` is used ONLY as a fallback
        // when no phase contributes, so it can no longer FIGHT the phase
        // allocation (which was the source of the "Remaining −$X" mismatch reds).
        function buildingEffectiveBudget(building, jobId) {
            var seen = {};
            var sum = 0;
            getPhasesWiredToBuilding(building.id).forEach(function(wp) {
                if (seen[wp.phase.id]) return;
                seen[wp.phase.id] = 1;
                sum += phaseRevenue(wp.phase) * ((wp.allocPct != null ? wp.allocPct : 100) / 100);
            });
            (appData.phases || []).forEach(function(p) {
                if (p.jobId !== jobId || p.buildingId !== building.id || seen[p.id]) return;
                seen[p.id] = 1;
                sum += phaseRevenue(p);
            });
            if (sum > 0) return { amount: sum, derived: true };
            if ((building.budget || 0) > 0) return { amount: building.budget, derived: false }; // legacy fallback only
            return { amount: 0, derived: true };
        }

        // ── Inline click-to-edit for the right-panel building/phase cards ──
        // Renders a number as a click-to-edit chip. On click it swaps to an
        // input; Enter/blur writes the field to the phase/building record
        // (same persistence as saveManagedPhase: saveData + NG t2 sync +
        // ensureNGComputed) and repaints the cards. NO canvas node editing —
        // this is the cards only, per John.
        function inlNum(ent, id, field, raw, fmt) {
            raw = raw || 0;
            var disp = (fmt === 'pct') ? (Math.round(raw * 10) / 10 + '%') : formatCurrency(raw);
            return '<span class="p86-inl" role="button" tabindex="0"' +
                ' data-inl-ent="' + ent + '" data-inl-id="' + escapeHTML(String(id)) + '"' +
                ' data-inl-field="' + field + '" data-inl-raw="' + raw + '" data-inl-fmt="' + (fmt || 'cur') + '"' +
                ' title="Click to edit" onclick="event.stopPropagation();window.p86InlStart&&window.p86InlStart(this);">' + disp + '</span>';
        }
        // Re-render whichever building/phase card hosts are mounted (map
        // inspector OR classic page), preserving expand state + refreshing
        // the map metric tiles.
        function p86RerenderJobCards(jobId) {
            var openIds = [];
            document.querySelectorAll('.p86-bldg-body, .ph-body').forEach(function(el) {
                if (el.style.display === 'table-row') openIds.push(el.id);
            });
            var bHost = document.getElementById('insp-buildings') || document.getElementById('job-buildings-content');
            if (bHost) { try { renderJobBuildings(jobId, bHost.id); } catch (e) {} }
            var pHost = document.getElementById('insp-phases');
            if (pHost && typeof renderOverviewPhasesInto === 'function') {
                var phs = (appData.phases || []).filter(function(p) { return p.jobId === jobId; });
                try { renderOverviewPhasesInto(pHost, jobId, phs); } catch (e) {}
            }
            if (typeof window.refreshInspMetrics === 'function') { try { window.refreshInspMetrics(); } catch (e) {} }
            openIds.forEach(function(id) {
                var el = document.getElementById(id); if (!el) return;
                el.style.display = 'table-row';
                var arrow = document.getElementById(id + '-arrow'); if (arrow) arrow.textContent = '▼';
            });
        }
        // Exposed so the Site-Plan CO allocation editor (nodegraph/ui.js) can
        // repaint the classic job-overview building cards after it saves.
        window.p86RerenderJobCards = p86RerenderJobCards;
        function p86CommitInline(span, rawStr) {
            var ent = span.getAttribute('data-inl-ent'),
                id = span.getAttribute('data-inl-id'),
                field = span.getAttribute('data-inl-field');
            var val = parseFloat(rawStr); if (isNaN(val) || val < 0) val = 0;
            if (field === 'pctComplete') val = Math.max(0, Math.min(100, val));
            var rec = (ent === 'phase')
                ? (appData.phases || []).find(function(p) { return p.id === id; })
                : (appData.buildings || []).find(function(b) { return b.id === id; });
            if (!rec) return;
            rec[field] = val;
            // asSold mirror + manual-% flag so the value survives recompute.
            if (ent === 'phase' && field === 'asSoldRevenue') { rec.asSoldPhaseBudget = val; }
            if (field === 'pctComplete') { rec.pctCompleteManual = true; }
            saveData();
            // Sync the wired t2/t1 node so the canvas + watch chips agree.
            if (typeof NG !== 'undefined') {
                try {
                    NG.nodes().forEach(function(n) {
                        if (n.data && n.data.id === id) {
                            if (field === 'asSoldRevenue') n.revenue = val;
                            // ensureNGComputed reads n.pctComplete (n.pct is the
                            // display mirror) — set both so the edit survives recompute.
                            if (field === 'pctComplete') { n.pct = val; n.pctComplete = val; }
                        }
                    });
                    NG.saveGraph();
                } catch (e) {}
            }
            var jid = appState.currentJobId;
            try { ensureNGComputed(jid); } catch (e) {}
            p86RerenderJobCards(jid);
        }
        // Called directly from a chip's onclick (the chip stops propagation so
        // it never toggles its parent row, which is why a document-delegated
        // listener can't see it — hence the direct call). Swaps the chip to an
        // input; commits on Enter/blur, cancels on Esc.
        function p86InlStart(span) {
            if (!span || span.querySelector('input') || span.dataset.editing === '1') return;
            span.dataset.editing = '1';
            var raw = span.getAttribute('data-inl-raw') || '0';
            var input = document.createElement('input');
            input.type = 'text'; input.inputMode = 'decimal'; input.value = raw;
            input.className = 'p86-inl-input';
            var prevHTML = span.innerHTML;
            span.innerHTML = ''; span.appendChild(input);
            input.focus(); input.select();
            var done = false;
            function commit() {
                if (done) return; done = true;
                p86CommitInline(span, input.value); // triggers a full card re-render
            }
            function cancel() {
                if (done) return; done = true;
                span.dataset.editing = '0'; span.innerHTML = prevHTML;
            }
            input.addEventListener('keydown', function(ev) {
                if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
                else if (ev.key === 'Escape') { ev.preventDefault(); cancel(); }
            });
            input.addEventListener('blur', function() { commit(); });
            input.addEventListener('click', function(ev) { ev.stopPropagation(); });
        }
        window.p86InlStart = p86InlStart;

        // Natural sort by the building name's number (B1, B2, … B10) so a
        // re-added/healed building lands in order, not appended at the end.
        function _bldgNumSort(a, b) {
            var na = parseInt(String(a.name || '').replace(/\D/g, ''), 10);
            var nb = parseInt(String(b.name || '').replace(/\D/g, ''), 10);
            if (!isNaN(na) && !isNaN(nb) && na !== nb) return na - nb;
            return String(a.name || '').localeCompare(String(b.name || ''));
        }
        function renderJobBuildings(jobId, hostId) {
            const buildings = appData.buildings.filter(b => b.jobId === jobId).slice().sort(_bldgNumSort);
            const container = document.getElementById(hostId || 'job-buildings-content');
            if (!container) return;   // host may be absent (e.g. node-graph inspector passes its own id)
            if (!buildings.length) { container.innerHTML = ''; return; }

            const totalBudget = buildings.reduce((s, b) => s + buildingEffectiveBudget(b, jobId).amount, 0);
            let totalSpent = 0;

            const rowsHTML = buildings.map(function(building) {
                const wiredPhases = getPhasesWiredToBuilding(building.id);
                let phaseCost = 0;
                wiredPhases.forEach(function(wp) {
                    var p = wp.phase;
                    var pct = (wp.allocPct != null ? wp.allocPct : 100) / 100;
                    phaseCost += ((p.materials || 0) + (p.labor || 0) + (p.sub || 0) + (p.equipment || 0)) * pct;
                });
                const bMat = building.materials || 0, bLab = building.labor || 0, bSub = building.sub || 0, bEquip = building.equipment || 0;
                const bldgDirectCost = bMat + bLab + bSub + bEquip;
                const buildingCost = phaseCost + bldgDirectCost;
                totalSpent += buildingCost;
                const eff = buildingEffectiveBudget(building, jobId);
                const variance = eff.amount - buildingCost;
                const bldgPct = totalBudget > 0 ? (eff.amount / totalBudget * 100).toFixed(1) : '—';
                const pctComplete = calcBuildingPctComplete(building.id, jobId).toFixed(1);
                const scope = building.workScope || 'in-house';
                // Scope chip color modifier: 'in-house' (accent blue) / 'sub'
                // (purple) / 'both' (yellow). Painted via CSS class so light
                // mode + theme tweaks just work.
                const scopeMod = scope === 'sub' ? 'scope-sub' : scope === 'both' ? 'scope-both' : 'scope-inhouse';

                const cosWired = getCOsConnectedTo('t1', building.id);
                const uid = 'bldg-grp-' + building.id.replace(/\W/g, '_');
                const ARROW_RIGHT = '\u25B6';
                const ARROW_DOWN = '\u25BC';
                const arrowId = uid + '-arrow';
                const varMod = variance >= 0 ? 'positive' : 'negative';
                const summaryRow =
                    '<tr class="p86-bldg-row" ' +
                        'onclick="(function(){var d=document.getElementById(\'' + uid + '\');var a=document.getElementById(\'' + arrowId + '\');var closed=d.style.display===\'none\';d.style.display=closed?\'table-row\':\'none\';a.textContent=closed?\'' + ARROW_DOWN + '\':\'' + ARROW_RIGHT + '\';})()">' +
                        '<td class="p86-bldg-cell p86-bldg-cell-name">' +
                            '<span id="' + arrowId + '" class="p86-bldg-arrow">' + ARROW_RIGHT + '</span> ' +
                            '<strong class="p86-bldg-name">' + escapeHTML(building.name) + '</strong>' +
                            (building.address ? '<span class="p86-bldg-addr">' + escapeHTML(building.address) + '</span>' : '') +
                            // The map-pin icon opens this building's address in Google Maps.
                            // stopPropagation so it doesn't also toggle the row.
                            (building.address && window.p86MapLink && window.p86MapLink.url(building.address)
                              ? ' <a href="' + window.p86MapLink.url(building.address).replace(/&/g, '&amp;') +
                                  '" target="_blank" rel="noopener" onclick="event.stopPropagation();" ' +
                                  'title="Open in Google Maps" style="text-decoration:none;margin-left:4px;">' + (window.p86Icon ? window.p86Icon('map-pin') : '') + '</a>'
                              : '') +
                        '</td>' +
                        '<td class="p86-bldg-cell p86-bldg-cell-num accent">' +
                            formatCurrency(eff.amount) +
                            (eff.derived ? '<span class="p86-bldg-co-tag" title="No explicit building budget — derived from this building\'s phase revenue">auto</span>' : '') +
                            // Legacy building.coBudget "+$X" tag retired: CO→building
                            // revenue now lives in the CO's buildingAllocations and
                            // renders in the building card's Change Orders block, so
                            // this stale wire-era scalar would double-display.
                        '</td>' +
                        '<td class="p86-bldg-cell p86-bldg-cell-num accent">' +
                            formatCurrency(buildingCost) +
                        '</td>' +
                        '<td class="p86-bldg-cell p86-bldg-cell-num ' + varMod + '">' +
                            formatCurrency(variance) +
                        '</td>' +
                        '<td class="p86-bldg-cell p86-bldg-cell-num pct">' +
                            pctComplete + '%' +
                        '</td>' +
                        '<td class="p86-bldg-cell p86-bldg-cell-num dim">' +
                            bldgPct + '%' +
                        '</td>' +
                        '<td class="p86-bldg-cell">' +
                            '<span class="p86-bldg-scope ' + scopeMod + '">' + escapeHTML(scope) + '</span>' +
                        '</td>' +
                        '<td class="p86-bldg-cell p86-bldg-cell-actions">' +
                            '<button class="ee-btn ghost p86-bldg-edit-btn" onclick="event.stopPropagation();editBuilding(\'' + escapeHTML(building.id) + '\')">&#x270F;&#xFE0F; Edit</button>' +
                        '</td>' +
                    '</tr>';

                let body = '<tr id="' + uid + '" class="p86-bldg-body"><td colspan="8">';

                // Cost breakdown
                // Building cost buckets are computed from wired phases/cost nodes
                // (read-outs) — inline editing them fights ensureNGComputed.
                body += '<div class="p86-bldg-cost-row">' +
                    '<span>Mat: <b>' + formatCurrency(bMat) + '</b></span>' +
                    '<span>Lab: <b>' + formatCurrency(bLab) + '</b></span>' +
                    '<span>Sub: <b>' + formatCurrency(bSub) + '</b></span>' +
                    '<span>Equip: <b>' + formatCurrency(bEquip) + '</b></span>' +
                    ((building.hoursTotal || building.rate) ? '<span class="p86-bldg-cost-meta">' + (building.hoursTotal || 0) + 'hrs' + (building.hoursWeek ? ' (' + building.hoursWeek + '/wk)' : '') + ' @ ' + formatCurrency(building.rate || 40) + '/hr</span>' : '') +
                    '</div>';

                // Phases (from node graph wiring)
                body += '<div class="p86-bldg-section-head">PHASES (' + wiredPhases.length + ')</div>';
                if (wiredPhases.length === 0) {
                    body += '<div class="p86-bldg-section-empty">No phases wired to this building on the Site Plan</div>';
                } else {
                    body += '<div class="p86-bldg-chip-list">';
                    wiredPhases.forEach(function(wp) {
                        var p = wp.phase;
                        var pCost = ((p.materials || 0) + (p.labor || 0) + (p.sub || 0) + (p.equipment || 0)) * wp.allocPct / 100;
                        // Phase completion color modifier (paints just the %,
                        // not the whole chip): done (green) / mid (amber) / dim.
                        var pMod = p.pctComplete >= 100 ? 'done' : p.pctComplete >= 50 ? 'mid' : 'dim';
                        var allocStr = wp.allocPct !== 100 ? ' (' + fmtAllocPct(wp.allocPct) + '%)' : '';
                        body += '<button class="p86-bldg-phase-chip" onclick="event.stopPropagation();editPhase(\'' + escapeHTML(p.id) + '\')">' +
                            escapeHTML(p.phase) + allocStr + ' <b class="' + pMod + '">' + (p.pctComplete || 0) + '%</b> ' + formatCurrency(pCost) + '</button>';
                    });
                    body += '</div>';
                }
                body += '<button class="p86-bldg-add-phase-btn" onclick="event.stopPropagation();openAddPhaseToJobModal(\'' + escapeHTML(building.id) + '\')">+ Phase</button>';

                // Change Orders wired to this building
                body += '<div class="p86-bldg-section-head">CHANGE ORDERS (' + cosWired.length + ')</div>';
                if (cosWired.length === 0) {
                    body += '<div class="p86-bldg-section-empty">No COs wired to this building</div>';
                } else {
                    body += '<div class="p86-bldg-co-list">';
                    cosWired.forEach(function(item) {
                        const c = item.co;
                        body += '<div class="p86-bldg-co-row" onclick="event.stopPropagation();editCO(\'' + escapeHTML(c.id) + '\')">' +
                            '<span><b>' + escapeHTML(c.coNumber || 'CO') + '</b> ' + escapeHTML((c.description || '').substring(0, 60)) + '</span>' +
                            '<span class="p86-bldg-co-row-meta">Inc: <b>' + formatCurrency((c.income || 0) * item.allocPct / 100) + '</b> (' + fmtAllocPct(item.allocPct) + '%)</span>' +
                            '</div>';
                    });
                    body += '</div>';
                }

                body += '</td></tr>';
                return summaryRow + body;
            }).join('');

            // Section summary — building budgets are the READ-OUT of the phase
            // allocation, so their sum reconciles against the job contract via
            // the SAME getJobBudgetRecon the Phases strip uses (they can't
            // disagree). When there's a gap, distribute it on the Phases card's
            // "Auto-fill" strip.
            var _recon = getJobBudgetRecon(jobId);
            var _totalVar = totalBudget - totalSpent;
            var _reconTxt = '';
            if (_recon.contract > 0) {
                var _rc = _recon.full ? 'var(--green)' : (_recon.over ? 'var(--red)' : 'var(--orange,#e0a458)');
                var _rtxt = _recon.full ? '✓' : (_recon.over ? '(over by ' + formatCurrency(-_recon.gap) + ' ⚠)' : '(' + formatCurrency(_recon.gap) + ' unallocated)');
                _reconTxt = ' <span style="color:var(--text-dim);">of</span> <b style="font-family:monospace;">' + formatCurrency(_recon.contract) + '</b> ' +
                    '<span style="color:' + _rc + ';font-weight:600;">' + _rtxt + '</span>';
            }
            // Total unit count across all buildings (units live on each building's
            // structure, synced onto the record) — a quick at-a-glance tally under
            // the building count.
            var _totalUnits = buildings.reduce(function (s, b) { return s + ((b.units && b.units.length) || 0); }, 0);
            var summaryHTML =
                '<div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin:0 0 8px;padding:7px 10px;border:1px solid var(--border);border-radius:8px;background:var(--card-bg,#141419);font-size:11.5px;">' +
                    '<span style="color:var(--text-dim);display:inline-flex;flex-direction:column;line-height:1.25;">' + buildings.length + ' buildings' +
                        '<span style="font-size:9.5px;color:var(--text-dim,#888);">' + _totalUnits + ' unit' + (_totalUnits === 1 ? '' : 's') + ' total</span>' +
                    '</span>' +
                    '<span style="color:var(--text-dim);">Budget <b style="color:var(--accent);font-family:monospace;">' + formatCurrency(totalBudget) + '</b>' + _reconTxt + '</span>' +
                    '<span style="color:var(--text-dim);">Spent <b style="color:var(--orange,#e0a458);font-family:monospace;">' + formatCurrency(totalSpent) + '</b></span>' +
                    '<span style="color:var(--text-dim);">Var <b style="color:' + (_totalVar >= 0 ? 'var(--green)' : 'var(--red)') + ';font-family:monospace;">' + formatCurrency(_totalVar) + '</b></span>' +
                    '<span style="color:var(--text-dim,#888);font-size:10.5px;margin-left:auto;">Budgets derive from each building\'s phase slices</span>' +
                '</div>';
            container.innerHTML = summaryHTML +
                '<div class="p86-bldg-table-wrap">' +
                    '<table class="p86-bldg-table">' +
                        '<thead class="p86-bldg-thead"><tr>' +
                            thCell('Building', 'left') +
                            thCell('Budget', 'right') +
                            thCell('Spent', 'right') +
                            thCell('Var', 'right') +
                            thCell('%', 'right') +
                            thCell('Of Job', 'right') +
                            thCell('Scope', 'left') +
                            thCell('', 'right') +
                        '</tr></thead>' +
                        '<tbody>' + rowsHTML + '</tbody>' +
                    '</table>' +
                '</div>';
        }

        // Shared <th> renderer used by renderJobBuildings AND a handful
        // of other tables in this file (POs, Invoices, COs). Outputs a
        // .p86-bldg-th cell with .l / .r modifier for left/right align;
        // the actual styling lives in css/styles.css under the Jobs
        // page block.
        function thCell(label, align) {
            return '<th class="p86-bldg-th ' + (align === 'right' ? 'r' : 'l') + '">' + label + '</th>';
        }

        function lookupConnDetails(item) {
            var d = item.data;
            if (!d || !d.id) return '';
            var type = item.nodeType;
            if (type === 't2') {
                var ph = appData.phases.find(function(p) { return p.id === d.id; });
                if (!ph) return '';
                var cost = (ph.materials || 0) + (ph.labor || 0) + (ph.sub || 0) + (ph.equipment || 0);
                var pColor = ph.pctComplete >= 100 ? 'var(--green)' : ph.pctComplete >= 50 ? '#f59e0b' : 'var(--text-dim)';
                return '<span style="color:var(--text-dim);font-size:10px;">Rev: <b style="color:var(--green);">' + formatCurrency(phaseRevenue(ph)) + '</b> Cost: <b>' + formatCurrency(cost) + '</b> <b style="color:' + pColor + ';">' + (ph.pctComplete || 0) + '%</b></span>';
            }
            if (type === 't1') {
                var bldg = appData.buildings.find(function(b) { return b.id === d.id; });
                if (!bldg) return '';
                // Phase-derived budget (matches the building card), not the stale
                // raw building.budget which is now typically 0.
                var _bb = buildingEffectiveBudget(bldg, bldg.jobId).amount;
                return '<span style="color:var(--text-dim);font-size:10px;">Budget: <b style="color:var(--accent);">' + formatCurrency(_bb) + '</b></span>';
            }
            if (type === 'sub') {
                var sub = appData.subs.find(function(s) { return s.id === d.id; });
                if (!sub) return '';
                return '<span style="color:var(--text-dim);font-size:10px;">Contract: <b style="color:var(--accent);">' + formatCurrency(sub.contractAmt || 0) + '</b> Billed: <b style="color:var(--green);">' + formatCurrency(sub.billedToDate || 0) + '</b></span>';
            }
            if (type === 'co') {
                var co = appData.changeOrders.find(function(c) { return c.id === d.id; });
                if (!co) return '';
                var allocStr = item.allocPct != null && item.allocPct !== 100 ? ' (' + fmtAllocPct(item.allocPct) + '%)' : '';
                return '<span style="color:var(--text-dim);font-size:10px;">Inc: <b style="color:var(--green);">' + formatCurrency(co.income || 0) + '</b>' + allocStr + ' Cost: <b>' + formatCurrency(co.estimatedCosts || 0) + '</b></span>';
            }
            if (type === 'po') {
                var po = appData.purchaseOrders.find(function(p) { return p.id === d.id; });
                if (!po) return '';
                return '<span style="color:var(--text-dim);font-size:10px;">Amt: <b>' + formatCurrency(po.amount || 0) + '</b> Billed: <b style="color:var(--green);">' + formatCurrency(po.billedToDate || 0) + '</b></span>';
            }
            if (type === 'inv') {
                var inv = appData.invoices.find(function(iv) { return iv.id === d.id; });
                if (!inv) return '';
                return '<span style="color:var(--text-dim);font-size:10px;">Amt: <b>' + formatCurrency(inv.amount || 0) + '</b></span>';
            }
            return '';
        }

        function connTypeIcon(type) {
            var icons = { t1: '&#x1F3D7;', t2: '&#x1F4CB;', sub: '&#x1F477;', co: '&#x1F4DD;', po: '&#x1F4C4;', inv: '&#x1F4B3;', wip: '&#x1F4CA;', watch: '&#x1F4CA;' };
            return icons[type] || '';
        }

        // RETIRED with the node/wiring model. Wiring no longer exists, so
        // "Site Plan Connections" and its "Not placed on graph yet" placeholder
        // are meaningless — a scope's relationship to a building is now the
        // allocation matrix, not a wire. Returns nothing so every caller
        // (phase rows, subs table) simply stops drawing the section.
        function renderConnectionList(conns) {
            return '';
        }
        function _retiredRenderConnectionList(conns) {
            if (!conns.length) return '';
            var html = '<div style="display:flex;flex-direction:column;gap:3px;">';
            conns.forEach(function(c, ci) {
                // Collect all connected items (targets and sources)
                var items = [];
                c.targets.forEach(function(t) { items.push({ dir: 'out', item: t }); });
                c.sources.forEach(function(s) { items.push({ dir: 'in', item: s }); });
                if (items.length === 0) {
                    html += '<div style="font-size:11px;padding:4px 8px;background:var(--surface);border:1px solid var(--border);border-radius:4px;color:var(--text-dim);">' +
                        '<span style="color:var(--purple);font-weight:600;">#' + (ci + 1) + '</span> Unconnected</div>';
                    return;
                }
                items.forEach(function(entry) {
                    var it = entry.item;
                    var arrow = entry.dir === 'out' ? '&rarr;' : '&larr;';
                    var arrowColor = entry.dir === 'out' ? 'var(--green)' : 'var(--accent)';
                    var details = lookupConnDetails(it);
                    html += '<div style="font-size:11px;padding:5px 10px;background:var(--surface);border:1px solid var(--border);border-radius:6px;display:flex;align-items:center;justify-content:space-between;gap:8px;">' +
                        '<div style="display:flex;align-items:center;gap:6px;">' +
                        '<span style="color:' + arrowColor + ';">' + arrow + '</span>' +
                        '<span>' + connTypeIcon(it.nodeType) + '</span>' +
                        '<span style="font-weight:600;color:var(--text);">' + escapeHTML(it.label) + '</span>' +
                        '</div>' +
                        (details ? '<div>' + details + '</div>' : '') +
                        '</div>';
                });
            });
            html += '</div>';
            return html;
        }

        function ensureNGLoaded(jobId) {
            if (typeof NG === 'undefined' || !jobId) return false;
            if (NG.job() === jobId && NG.nodes().length > 0) return true;
            NG.job(jobId);
            NG.setNodes([]); NG.setWires([]); NG.setNid(1);
            return NG.loadGraph();
        }

        // Loads the graph AND runs a silent compute so job.ngActualCosts /
        // ngAccruedCosts / phase costs are current before overview + sticky
        // metrics read them. Safe to call repeatedly.
        function ensureNGComputed(jobId) {
            if (!ensureNGLoaded(jobId)) return false;
            if (typeof window.ngPushToJob === 'function') {
                try { window.ngPushToJob(); } catch (e) {}
            }
            return true;
        }

        // Cloud sync the node graph for this job. Pre-fix: cloud sync only
        // ran from nodegraph/ui.js's mount path, so opening a job whose
        // graph wasn't in localStorage left the building cards showing
        // empty wire data ("PHASES (0)") until the user opened the
        // workspace. After this, renderJobDetail triggers cloud sync
        // and re-renders the building section ONLY IF no input is
        // focused — protects users mid-typing from losing their input.
        // Idempotent: skips when another sync is already in flight for
        // the same job.
        var _ngCloudSyncInFlight = null;
        function ensureNGCloudSynced(jobId, onApplied) {
            if (typeof NG === 'undefined' || !jobId) return;
            if (typeof NG.loadGraphFromCloudAndApply !== 'function') return;
            if (_ngCloudSyncInFlight === jobId) return;
            _ngCloudSyncInFlight = jobId;
            NG.loadGraphFromCloudAndApply().then(function(applied) {
                _ngCloudSyncInFlight = null;
                if (!applied) return;
                // Refresh ngPushToJob so per-phase rolled-up costs are
                // current. Cheap; same call ensureNGComputed makes.
                if (typeof window.ngPushToJob === 'function') {
                    try { window.ngPushToJob(); } catch (_) {}
                }
                // Guard the re-render against focused inputs. If the
                // user is mid-typing in any input/textarea (e.g. a
                // building budget, phase pct, WIP field, wire
                // allocPct), DO NOT re-render — that would wipe their
                // input value before they finished. The data is
                // already updated in memory; next user interaction
                // re-renders naturally.
                var ae = document.activeElement;
                if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' ||
                           ae.tagName === 'SELECT' || ae.isContentEditable)) {
                    console.log('[jobs] cloud-sync re-render deferred — input focused:', ae.tagName);
                    return;
                }
                if (typeof onApplied === 'function') {
                    try { onApplied(); }
                    catch (e) { console.warn('[jobs] cloud-sync re-render failed:', e); }
                }
            }).catch(function(e) {
                _ngCloudSyncInFlight = null;
                console.warn('[jobs] cloud-sync failed:', e && e.message);
            });
        }

        function getNodeGraphConnections(type, dataId) {
            if (typeof NG === 'undefined') return [];
            ensureNGLoaded(appState.currentJobId);
            var nodes = NG.nodes(), wires = NG.wires();
            var instances = nodes.filter(function(n) { return n.type === type && n.data && n.data.id === dataId; });
            var conns = [];
            instances.forEach(function(n) {
                var outWires = wires.filter(function(w) { return w.fromNode === n.id; });
                var inWires = wires.filter(function(w) { return w.toNode === n.id; });
                var targets = outWires.map(function(w) {
                    var tn = NG.findNode(w.toNode);
                    return tn ? { label: tn.label, type: tn.type, port: w.toPort, data: tn.data, nodeType: tn.type } : null;
                }).filter(Boolean);
                var sources = inWires.map(function(w) {
                    var fn = NG.findNode(w.fromNode);
                    return fn ? { label: fn.label, type: fn.type, port: w.fromPort, data: fn.data, nodeType: fn.type, allocPct: w.allocPct } : null;
                }).filter(Boolean);
                conns.push({ nodeId: n.id, label: n.label, targets: targets, sources: sources });
            });
            return conns;
        }

        // Find COs that wire (in node graph) to a particular T1/T2 by data.id.
        // Returns array of { co (appData entry), wireAllocPct }.
        function getCOsConnectedTo(targetType, targetDataId) {
            if (typeof NG === 'undefined') return [];
            ensureNGLoaded(appState.currentJobId);
            var nodes = NG.nodes(), wires = NG.wires();
            var targetNodes = nodes.filter(function(n) { return n.type === targetType && n.data && n.data.id === targetDataId; });
            var targetIds = {};
            targetNodes.forEach(function(n) { targetIds[n.id] = 1; });
            var results = [];
            wires.forEach(function(w) {
                if (!targetIds[w.toNode]) return;
                var src = NG.findNode(w.fromNode);
                if (!src || src.type !== 'co' || !src.data || !src.data.id) return;
                // Server COs live in appData.jobChangeOrders — money is in c.lines
                // via the shared pricing pipeline, NOT a flat income field. (The old
                // code read the dead appData.changeOrders relic, so every wired CO
                // resolved to nothing and building-level CO income was always $0,
                // never summing to the job's CO total.) Compute income/cost exactly
                // like getJobCOTotals and expose them as co.income/co.estimatedCosts
                // so the card consumer reads correctly. Fall back to the legacy
                // relic for any pre-server CO that still carries flat fields.
                var srv = (appData.jobChangeOrders || []).find(function(c) { return c.id === src.data.id; });
                var coEntry;
                if (srv) {
                    var lines = Array.isArray(srv.lines) ? srv.lines : [];
                    var income = 0, cost = 0;
                    if (window.p86Pricing) {
                        var per = window.p86Pricing.computeForLines(srv, lines);
                        var markedUp = window.p86Pricing.targetMarginActive(srv)
                            ? window.p86Pricing.applyTargetMargin(per.subtotal, srv) : per.markedUp;
                        income = window.p86Pricing.applyFeesAndTax(markedUp, srv).total;
                        cost = per.subtotal;
                    }
                    coEntry = Object.assign({}, srv, { income: income, estimatedCosts: cost });
                } else {
                    coEntry = (appData.changeOrders || []).find(function(c) { return c.id === src.data.id; });
                }
                if (!coEntry) return;
                results.push({ co: coEntry, allocPct: w.allocPct != null ? w.allocPct : 100 });
            });
            return results;
        }

        // Find phases (T2 nodes) wired to a particular building (T1 node) in the node graph.
        // Returns array of { phase (appData entry), allocPct, t2NodeId }, deduplicated by phase.id.
        function getPhasesWiredToBuilding(buildingId) {
            if (typeof NG === 'undefined') return [];
            ensureNGLoaded(appState.currentJobId);
            var nodes = NG.nodes(), wires = NG.wires();
            var t1Nodes = nodes.filter(function(n) { return n.type === 't1' && n.data && n.data.id === buildingId; });
            var t1Ids = {};
            t1Nodes.forEach(function(n) { t1Ids[n.id] = 1; });
            var seen = {};
            var results = [];
            wires.forEach(function(w) {
                if (!t1Ids[w.toNode]) return;
                var src = NG.findNode(w.fromNode);
                if (!src || src.type !== 't2' || !src.data || !src.data.id) return;
                var phEntry = appData.phases.find(function(p) { return p.id === src.data.id; });
                if (!phEntry) return;
                var key = phEntry.id + '|' + src.id;
                if (seen[key]) return;
                seen[key] = 1;
                results.push({ phase: phEntry, allocPct: w.allocPct != null ? w.allocPct : 100, t2NodeId: src.id });
            });
            return results;
        }

        function renderConnectionBadges(conns) {
            return renderConnectionList(conns);
        }

        // RETIRED: the "Phases (N)" card. It listed each scope with per-building
        // instance rows carrying node-graph wiring state ("Not placed on graph
        // yet"), duplicating revenue/cost/profit the Scopes × Buildings
        // allocation matrix already shows per scope AND per building. One
        // allocation surface, and the tier is called Scopes now, not Phases.
        // Kept as a clearing no-op so its several call sites stay harmless.
        function renderOverviewPhasesInto(container, jobId, phases) {
            if (container) container.innerHTML = '';
            pruneEmptyUnassignedPhases(jobId);   // keep the self-heal this used to run
        }
        function _retiredRenderOverviewPhasesInto(container, jobId, phases) {
            container.innerHTML = '';
            // Self-heal: drop any empty "Unassigned" phase remnants left by the
            // create-then-split flow, and mirror the removal into the list we render.
            var _pruned = pruneEmptyUnassignedPhases(jobId);
            if (_pruned.length) {
                var _rm = {}; _pruned.forEach(function(id) { _rm[id] = 1; });
                phases = (phases || []).filter(function(p) { return !_rm[p.id]; });
                if (typeof saveData === 'function') saveData();
            }
            const phaseGroups = {};
            phases.forEach(p => {
                var key = p.phase || 'Unnamed';
                if (!phaseGroups[key]) phaseGroups[key] = [];
                phaseGroups[key].push(p);
            });

            const groupKeys = Object.keys(phaseGroups).sort();
            let totalRev = 0, totalCost = 0;
            groupKeys.forEach(k => {
                phaseGroups[k].forEach(r => {
                    totalRev += phaseRevenue(r);
                    totalCost += (r.materials || 0) + (r.labor || 0) + (r.sub || 0) + (r.equipment || 0);
                });
            });
            const totalProfit = totalRev - totalCost;

            // Contract-reconciliation strip — measures what actually reaches
            // BUILDINGS (the same number the Buildings summary shows), so the two
            // can never disagree. One-click auto-fills the gap onto empty phases.
            var _recon = getJobBudgetRecon(jobId);
            var reconHTML = '';
            if (_recon.contract > 0) {
                var _pctA = Math.max(0, Math.min(100, Math.round(_recon.onBuildings / _recon.contract * 100)));
                var _barCol = _recon.full ? 'var(--green)' : (_recon.over ? 'var(--red)' : 'var(--orange,#e0a458)');
                var _state = _recon.full ? 'fully allocated ✓' : (_recon.over ? ('over by ' + formatCurrency(-_recon.gap) + ' ⚠') : (formatCurrency(_recon.gap) + ' unallocated'));
                // A phase is "fillable" when nothing has landed on its buildings yet.
                var _anyFillable = _recon.hasBuildings && groupKeys.some(function(n) { return getPhaseLandedOnBuildings(jobId, n) <= 0.5; });
                var _fillBtn = (!_recon.full && !_recon.over && _anyFillable)
                    ? '<button class="ee-btn" style="font-size:11px;padding:3px 10px;white-space:nowrap;background:var(--accent);color:#fff;border-color:var(--accent);" onclick="onDistributeContract(this)" title="Split the unallocated contract evenly across the phases that have not reached buildings yet, then spread each across its buildings by units/levels">&#9889; Auto-fill ' + formatCurrency(_recon.gap) + '</button>'
                    : '';
                var _unNote = (_recon.unassigned > 0.5) ? '<span style="font-size:10.5px;color:var(--orange,#e0a458);white-space:nowrap;" title="Phase budget parked on the job level, not yet on a building">' + formatCurrency(_recon.unassigned) + ' on Unassigned</span>' : '';
                var _noBldgNote = (!_recon.hasBuildings) ? '<span style="font-size:10.5px;color:var(--text-dim);white-space:nowrap;">add buildings to allocate</span>' : '';
                reconHTML =
                    '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:0 0 8px;padding:7px 10px;border:1px solid var(--border);border-radius:8px;background:var(--card-bg,#141419);">' +
                        '<span style="font-size:11.5px;color:var(--text-dim);white-space:nowrap;">Contract <b style="color:var(--text);font-family:monospace;">' + formatCurrency(_recon.contract) + '</b></span>' +
                        '<div style="flex:1;min-width:100px;height:7px;border-radius:4px;background:var(--overlay-light,rgba(255,255,255,0.07));overflow:hidden;"><div style="height:100%;width:' + _pctA + '%;background:' + _barCol + ';"></div></div>' +
                        '<span style="font-size:11.5px;color:' + _barCol + ';font-weight:600;white-space:nowrap;">' + formatCurrency(_recon.onBuildings) + ' on buildings · ' + _state + '</span>' +
                        _unNote + _noBldgNote + _fillBtn +
                    '</div>';
            }

            const titleHTML =
                '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;gap:10px;flex-wrap:wrap;">' +
                    '<h3 style="font-size:13px;margin:0;">&#x1F4CB; Phases (' + groupKeys.length + ')</h3>' +
                    '<div style="display:flex;align-items:center;gap:10px;">' +
                        '<div style="font-size:12px;color:var(--text-dim);">Rev: <b style="color:var(--green);">' + formatCurrency(totalRev) + '</b> &nbsp; Cost: <b>' + formatCurrency(totalCost) + '</b> &nbsp; Profit: <b style="color:' + (totalProfit >= 0 ? 'var(--green)' : 'var(--red)') + ';">' + formatCurrency(totalProfit) + '</b></div>' +
                        '<button class="ee-btn ghost" style="font-size:12px;padding:3px 10px;white-space:nowrap;" onclick="addJobLevelPhase(\'' + escapeHTML(jobId) + '\')">+ Phase</button>' +
                    '</div>' +
                '</div>' + reconHTML;

            if (groupKeys.length === 0) {
                container.innerHTML = titleHTML +
                    '<div style="padding:12px;text-align:center;color:var(--text-dim);font-size:12px;">No phases yet. Click + Phase above to add one.</div>';
                return;
            }

            const ARROW_RIGHT = '▶';
            const ARROW_DOWN = '▼';

            const rowsHTML = groupKeys.map(function(phaseName) {
                const phaseList = phaseGroups[phaseName];
                const revTotal = phaseList.reduce((s, p) => s + phaseRevenue(p), 0);
                const matTotal = phaseList.reduce((s, p) => s + (p.materials || 0), 0);
                const labTotal = phaseList.reduce((s, p) => s + (p.labor || 0), 0);
                const subTotal = phaseList.reduce((s, p) => s + (p.sub || 0), 0);
                const equipTotal = phaseList.reduce((s, p) => s + (p.equipment || 0), 0);
                const costTotal = matTotal + labTotal + subTotal + equipTotal;
                const profitTotal = revTotal - costTotal;
                const avgPct = Math.round(phaseList.reduce((s, p) => s + (p.pctComplete || 0), 0) / phaseList.length);
                const uid = 'ph-grp-' + phaseName.replace(/\W/g, '_');
                const arrowId = uid + '-arrow';

                const summaryRow =
                    '<tr class="ph-row" style="cursor:pointer;user-select:none;border-bottom:1px solid var(--overlay-light,rgba(255,255,255,0.04));" ' +
                        'onclick="(function(){var d=document.getElementById(\'' + uid + '\');var a=document.getElementById(\'' + arrowId + '\');var closed=d.style.display===\'none\';d.style.display=closed?\'table-row\':\'none\';var open=closed;a.textContent=open?\'' + ARROW_DOWN + '\':\'' + ARROW_RIGHT + '\';})()">' +
                        '<td style="white-space:nowrap;padding:6px 10px;">' +
                            '<span id="' + arrowId + '" style="font-size:10px;color:var(--text-dim);display:inline-block;width:10px;">' + ARROW_RIGHT + '</span> ' +
                            '<strong style="color:var(--text,#fff);font-size:13px;">' + escapeHTML(phaseName) + '</strong>' +
                        '</td>' +
                        '<td class="num" style="text-align:right;white-space:nowrap;padding:6px 10px;font-size:12px;color:var(--text-dim,#aaa);">' +
                            phaseList.length +
                        '</td>' +
                        '<td class="num" style="text-align:right;white-space:nowrap;padding:6px 10px;font-family:\'SF Mono\',monospace;font-size:13px;color:var(--green);font-weight:600;">' +
                            formatCurrency(revTotal) +
                        '</td>' +
                        '<td class="num" style="text-align:right;white-space:nowrap;padding:6px 10px;font-family:\'SF Mono\',monospace;font-size:13px;color:var(--orange);font-weight:600;">' +
                            formatCurrency(costTotal) +
                        '</td>' +
                        '<td class="num" style="text-align:right;white-space:nowrap;padding:6px 10px;font-family:\'SF Mono\',monospace;font-size:13px;font-weight:600;color:' + (profitTotal >= 0 ? 'var(--green)' : 'var(--red)') + ';">' +
                            formatCurrency(profitTotal) +
                        '</td>' +
                        '<td class="num" style="text-align:right;white-space:nowrap;padding:6px 10px;font-family:\'SF Mono\',monospace;font-size:13px;font-weight:700;color:var(--accent);">' +
                            avgPct + '%' +
                        '</td>' +
                    '</tr>';

                let body = '<tr id="' + uid + '" class="ph-body" style="display:none;"><td colspan="6" style="padding:8px 12px;background:var(--surface2);border-bottom:1px solid var(--border,#333);">';
                phaseList.forEach(function(p) {
                    var bldg = appData.buildings.find(function(b) { return b.id === p.buildingId; });
                    var bldgName = bldg ? bldg.name : (p.buildingId ? '?' : 'Job-level (unassigned)');
                    var conns = getNodeGraphConnections('t2', p.id);
                    body += '<div style="padding:6px 0;border-bottom:1px solid var(--border);">' +
                        '<div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px;">' +
                        '<div>' +
                        '<span style="font-size:13px;font-weight:600;color:var(--text);">' + escapeHTML(bldgName) + '</span>' +
                        // Rev + %Complete are user-set (they sync the wired t2 node and
                        // survive ensureNGComputed) → click-to-edit. Mat/Lab/Sub/Equip are
                        // ACTUAL costs computed from wired cost nodes/receipts — read-outs.
                        '<span style="font-size:11px;color:var(--text-dim);margin-left:8px;">Rev: ' + inlNum('phase', p.id, 'asSoldRevenue', phaseRevenue(p), 'cur') + ' | Mat: ' + formatCurrency(p.materials || 0) + ' | Lab: ' + formatCurrency(p.labor || 0) + ' | Sub: ' + formatCurrency(p.sub || 0) + ' | Equip: ' + formatCurrency(p.equipment || 0) + ' | <b style="color:var(--accent);">' + inlNum('phase', p.id, 'pctComplete', p.pctComplete || 0, 'pct') + '</b></span>' +
                        '</div>' +
                        '<button class="ee-btn ghost" onclick="event.stopPropagation();editPhase(\'' + escapeHTML(p.id) + '\')">&#x270F;&#xFE0F; Edit</button>' +
                        '</div>' +
                        '<div style="margin-top:4px;">' + renderConnectionList(conns) + '</div>' +
                        '</div>';
                });
                body += '</td></tr>';
                return summaryRow + body;
            }).join('');

            // Compact flat phase table (Phase / Instances / Rev / Cost / Profit /
            // Avg%). Used for jobs with NO buildings (matrix renders nothing) AND
            // as the non-duplicating stand-in in any background host — see below.
            var compactTable =
                '<div style="border:1px solid var(--border,#333);border-radius:10px;overflow-x:auto;background:var(--card-bg,#141419);">' +
                    '<table style="width:100%;border-collapse:collapse;table-layout:auto;">' +
                        '<thead style="background:var(--overlay-light,rgba(255,255,255,0.02));border-bottom:1px solid var(--border,#333);"><tr>' +
                            thCell('Phase', 'left') + thCell('Instances', 'right') + thCell('Revenue', 'right') +
                            thCell('Cost', 'right') + thCell('Profit', 'right') + thCell('Avg %', 'right') +
                        '</tr></thead>' +
                        '<tbody>' + rowsHTML + '</tbody>' +
                    '</table>' +
                '</div>';
            // The wide Buildings × Phases matrix must render in ONE surface only.
            // On the Site-Plan route the node-graph is a fixed full-screen overlay
            // whose INSPECTOR (#insp-phases) shows the matrix — but the classic job
            // overview (#job-overview-phases) is still mounted behind it and would
            // render an identical second copy (double work + the dedupe/heal firing
            // twice). So when the overlay is live, only hosts INSIDE it get the
            // matrix; any background host shows the compact table instead.
            var _bldgs = (appData.buildings || []).filter(function(b) { return b.jobId === jobId; });
            var _ng = document.getElementById('nodeGraphTab');
            // Use ROUTE / element EXISTENCE, not offsetParent visibility: during the
            // initial paint the classic overview renders before the node-graph overlay
            // is laid out, so a visibility check would miss it and BOTH would draw the
            // matrix. The pathname + #nodeGraphTab existence are known from first paint.
            var _onMap = !!_ng || /job-site-map/i.test((location && location.pathname) || '');
            var _suppressMatrix = _onMap && !(_ng && _ng.contains(container));
            if (_bldgs.length === 0 || _suppressMatrix) {
                container.innerHTML = titleHTML + compactTable;
            } else {
                // ONE allocation surface: the Scopes×Buildings matrix. The old
                // per-scope card editor (Cards view) is retired — it duplicated
                // the matrix's controls (building coverage, Even/Units/Levels
                // split, per-building override) through the same primitives, and
                // two editors for the same money invited them to drift. Coverage
                // is now the matrix's tick-scopes + tick-buildings → Link action.
                container.innerHTML = titleHTML + '<div class="phase-matrix-host"></div>';
                var _host = container.querySelector('.phase-matrix-host');
                try { renderPhaseMatrixInto(_host, jobId); } catch (e) {}
            }
        }

        // ── Buildings × Phases matrix — the job-first budget breakdown ──────
        // Rows = phase names, columns = buildings + Unassigned + Total. Each
        // cell = that phase's as-sold budget slice for that building (editable).
        // Row total = the phase's job-level total (sum of its slices); column
        // total = each building's roll-up; grand total = the job's phased
        // budget. Editing a cell writes the per-(phase,building) phase record's
        // asSoldPhaseBudget (create-on-demand) — the same survivable field the
        // building breakdown modal uses (SP-1: building budget derives from it).
        // ── Buildings × Phases allocation helpers ───────────────────────────
        // Stored source of truth is always each (phase,building) record's as-sold
        // REVENUE (mirrored to asSoldPhaseBudget/phaseBudget). % mode is an entry
        // convenience that computes those dollars from a phase total. Fields on
        // the phase records: allocMode ('pct'|'dollar', synced across a phase's
        // records), phaseAllocTotal (phase total $ in % mode), allocPct (a
        // building's share 0-100), allocAuto (is that share auto-even-split).
        // Same revenue basis as phaseRevenue() — kept as a named alias so the
        // allocation code reads clearly. ONE definition of the chain (was a
        // byte-identical duplicate that could drift from phaseRevenue).
        function phaseDollar(r) { return phaseRevenue(r); }

        function phaseAllocInfo(jobId, name) {
            var recs = (appData.phases || []).filter(function(p) { return p.jobId === jobId && (p.phase || 'Unnamed') === name; });
            var mode = 'pct', totalStored = null;
            recs.forEach(function(r) { if (r.allocMode) mode = r.allocMode; if (r.phaseAllocTotal != null) totalStored = r.phaseAllocTotal; });
            var sumD = recs.reduce(function(s, r) { return s + phaseDollar(r); }, 0);
            var total = (mode === 'pct' && totalStored != null) ? totalStored : sumD;
            return { recs: recs, mode: mode, total: total, sumDollars: sumD };
        }

        // Remove the empty "Unassigned" phase remnant left behind when a phase
        // created at the job level is fully split to buildings via the matrix. The
        // phase keeps one buildingId:null "Unassigned bucket" record; once its value
        // moves onto buildings that bucket sits at $0 and clutters the dropdown as a
        // "Job-level (unassigned)" row. Prune ONLY buckets that are TRULY empty (no $,
        // no %, no cost) AND whose phase name is allocated to at least one building —
        // so a genuine job-level phase (no building siblings) or one carrying any
        // value is never touched. Returns the removed record ids.
        function pruneEmptyUnassignedPhases(jobId) {
            if (!appData || !Array.isArray(appData.phases)) return [];
            var hasBldg = {};
            appData.phases.forEach(function(p) { if (p && p.jobId === jobId && p.buildingId) hasBldg[p.phase || 'Unnamed'] = 1; });
            var removed = [];
            appData.phases = appData.phases.filter(function(p) {
                if (!p || p.jobId !== jobId || p.buildingId) return true;          // keep other jobs + building-assigned
                var money = (p.asSoldRevenue || 0) + (p.asSoldPhaseBudget || 0) + (p.phaseBudget || 0) + (p.coPhaseBudget || 0)
                          + (p.materials || 0) + (p.labor || 0) + (p.sub || 0) + (p.equipment || 0);
                var empty = money === 0 && !(Number(p.pctComplete) > 0);
                if (empty && hasBldg[p.phase || 'Unnamed']) { removed.push(p.id); return false; }  // empty remnant → drop
                return true;
            });
            return removed;
        }
        function phaseRecFor(jobId, name, bid) {
            var rec = appData.phases.find(function(p) { return p.jobId === jobId && (p.phase || 'Unnamed') === name && (p.buildingId || null) === (bid || null); });
            if (!rec) {
                rec = { id: 'p' + Date.now() + Math.floor(Math.random() * 1000), jobId: jobId, buildingId: bid || null,
                    phase: name, workScope: 'in-house', locked: false, pctComplete: 0,
                    materials: 0, labor: 0, sub: 0, equipment: 0,
                    asSoldRevenue: 0, asSoldPhaseBudget: 0, coPhaseBudget: 0, phaseBudget: 0,
                    hoursWeek: 0, hoursTotal: 0, rate: 40, notes: '' };
                appData.phases.push(rec);
            }
            return rec;
        }

        function setPhaseDollar(rec, val) {
            rec.asSoldPhaseBudget = val;
            rec.phaseBudget = val + (rec.coPhaseBudget || 0);
            rec.asSoldRevenue = val; // mirror — the graph weights phases by revenue
        }

        // Resolve each building's % share for a % -mode phase. A share is MANUAL
        // if the record carries an explicit allocPct override OR carries dollars
        // (legacy/$-entered → derive its % so nothing moves); everything else is
        // AUTO and splits the remaining % evenly. This keeps % the default WITHOUT
        // ever rewriting an existing dollar split to an even one.
        function phasePctShares(jobId, name) {
            var info = phaseAllocInfo(jobId, name);
            var total = info.total || 0;
            var buildings = (appData.buildings || []).filter(function(b) { return b.jobId === jobId; });
            var targets = buildings.map(function(b) { return b.id; }); targets.push(null);
            var manualSum = 0, autoKeys = [], out = {};
            targets.forEach(function(bid) {
                var key = bid || '__un__';
                var rec = info.recs.find(function(r) { return (r.buildingId || null) === (bid || null); });
                // Order matters: an explicit allocAuto===true share always rebalances,
                // even once recompute has stamped dollars on it — checking dollars
                // first would freeze auto cells as "manual" and break the rebalance.
                if (rec && rec.allocAuto === true) { out[key] = { pct: null, auto: true }; autoKeys.push(key); }
                else if (rec && rec.allocPct != null) { out[key] = { pct: rec.allocPct, auto: false }; manualSum += rec.allocPct; }
                else if (rec && phaseDollar(rec) > 0 && total > 0) { var dp = phaseDollar(rec) / total * 100; out[key] = { pct: dp, auto: false }; manualSum += dp; } // legacy $-only row → preserve as manual
                else { out[key] = { pct: null, auto: true }; autoKeys.push(key); }
            });
            // Split the remaining % across the AUTO buildings, weighted by each
            // building's units (preferred) or levels. A building with none of
            // either is filled with the average of the ones that do, so it still
            // gets a fair share (never $0 by accident). If NO auto building has any
            // units/levels, fall back to an even split (John's call). The
            // Unassigned column carries no unit weight, so a units/levels split
            // sends the whole phase to buildings.
            var remaining = Math.max(0, 100 - manualSum);
            // Explicit split preference (allocSplit: 'even'|'units'|'levels'),
            // set from the allocation editor's segmented control. When absent the
            // legacy auto behavior (units, then levels) applies.
            var splitPref = null;
            info.recs.forEach(function(r) { if (r.allocSplit) splitPref = r.allocSplit; });
            var weightFor = function(key) {
                if (key === '__un__') return 0;
                var b = buildings.find(function(x) { return x.id === key; });
                if (!b) return 0;
                var u = (b.units || []).length, l = (b.levels || []).length;
                if (splitPref === 'even') return 0;              // 0 weight everywhere → even fallback below
                if (splitPref === 'levels') return l > 0 ? l : 0;
                if (splitPref === 'units') return u > 0 ? u : 0;
                return u > 0 ? u : (l > 0 ? l : 0);              // auto default: units, then levels
            };
            var weights = {}, nonZero = [];
            autoKeys.forEach(function(k) { var w = weightFor(k); weights[k] = w; if (w > 0) nonZero.push(w); });
            if (nonZero.length) {
                var avgNZ = nonZero.reduce(function(s, x) { return s + x; }, 0) / nonZero.length;
                var wSum = 0;
                autoKeys.forEach(function(k) { if (k !== '__un__' && weights[k] === 0) weights[k] = avgNZ; wSum += weights[k]; });
                autoKeys.forEach(function(k) { out[k].pct = wSum > 0 ? remaining * weights[k] / wSum : 0; });
            } else {
                // Even split — across BUILDINGS only; Unassigned never grabs a
                // share (a phase's budget belongs on its buildings).
                var evenKeys = autoKeys.filter(function(k) { return k !== '__un__'; });
                var each = evenKeys.length ? remaining / evenKeys.length : 0;
                autoKeys.forEach(function(k) { out[k].pct = (k === '__un__') ? 0 : each; });
            }
            return { targets: targets, shares: out };
        }

        // Write dollars from the resolved % shares × the phase total. Creates a
        // record for any building whose computed share is non-zero.
        function recomputePhasePctAllocation(jobId, name) {
            var info = phaseAllocInfo(jobId, name);
            if (info.mode !== 'pct') return;
            var total = info.total || 0;
            var res = phasePctShares(jobId, name);
            // Whole-dollar LARGEST REMAINDER, so the cells sum EXACTLY to what
            // the percentages describe. Rounding each cell on its own drifts —
            // a $92,000 Gutters row spread over 10 buildings landed as $92,003 —
            // and a scope that cannot reconcile to its own total can never
            // reconcile to the contract. distributeContractToPhases already uses
            // this technique for the same reason.
            var plan = res.targets.map(function(bid) {
                var key = bid || '__un__';
                var share = res.shares[key] || { pct: 0, auto: true };
                var exact = total * (share.pct || 0) / 100;
                return { bid: bid, share: share, exact: exact, base: Math.floor(exact), dollars: 0 };
            });
            var assigned = plan.reduce(function(s, p) { return s + p.base; }, 0);
            var exactSum = plan.reduce(function(s, p) { return s + p.exact; }, 0);
            // Distribute only the ROUNDING difference. Deliberately measured
            // against the shares' own sum, not `total`: when the percentages
            // intentionally leave the phase under-allocated, forcing the cells up
            // to `total` would invent money the user never allocated.
            var rem = Math.round(exactSum) - assigned;
            plan.forEach(function(p) { p.dollars = p.base; });
            plan.slice()
                .sort(function(a, b) { return (b.exact - b.base) - (a.exact - a.base); })
                .forEach(function(p, i) { if (i < rem) p.dollars += 1; });
            plan.forEach(function(p) {
                var rec = info.recs.find(function(r) { return (r.buildingId || null) === (p.bid || null); });
                if (!rec && p.dollars === 0) return; // don't materialize empty cells
                rec = rec || phaseRecFor(jobId, name, p.bid);
                rec.allocMode = 'pct';
                rec.phaseAllocTotal = total;
                if (p.share.auto) { rec.allocAuto = true; }
                else { rec.allocPct = p.share.pct || 0; rec.allocAuto = false; }
                setPhaseDollar(rec, p.dollars);
            });
        }

        // Collapse duplicate (phase, building) records for a job into one. The
        // graph↔appData orphan-heal can leave a building with two records for the
        // same phase — a $-carrying twin plus a $0 phantom — so a cell edit /
        // spread writes one while the matrix's find() reads the other (B1 showing
        // $0 while its money sits on the twin). Keep the richest rec (dollars then
        // % complete), drop the rest. Returns the count removed. Mutates appData;
        // callers persist when removed > 0.
        function dedupePhaseRecords(jobId) {
            var groups = {}, order = [];
            (appData.phases || []).forEach(function(p) {
                if (p.jobId !== jobId) return;
                var k = (p.phase || 'Unnamed') + '|' + (p.buildingId || '__un__');
                if (!groups[k]) { groups[k] = []; order.push(k); }
                groups[k].push(p);
            });
            var dropIds = {}, removed = 0;
            var val = function(r) { return r.asSoldRevenue || r.asSoldPhaseBudget || r.phaseBudget || 0; };
            order.forEach(function(k) {
                var arr = groups[k]; if (arr.length < 2) return;
                arr.sort(function(a, b) { var d = val(b) - val(a); return d !== 0 ? d : (b.pctComplete || 0) - (a.pctComplete || 0); });
                for (var i = 1; i < arr.length; i++) { dropIds[arr[i].id] = 1; removed++; }
            });
            if (removed) appData.phases = (appData.phases || []).filter(function(p) { return !dropIds[p.id]; });
            return removed;
        }

        // Selected building ids for the matrix multi-select ("Apply to selected").
        // Reset when the job changes so a stale selection can't leak across jobs.
        var _mxSel = {}, _mxPhaseSel = {}, _mxSelJob = null;
        function renderPhaseMatrixInto(container, jobId) {
            if (!container) return;
            if (_mxSelJob !== jobId) { _mxSel = {}; _mxPhaseSel = {}; _mxSelJob = jobId; }
            dedupePhaseRecords(jobId); // self-heal orphan-twin phase records before painting
            var phases = (appData.phases || []).filter(function(p) { return p.jobId === jobId; });
            var buildings = (appData.buildings || []).filter(function(b) { return b.jobId === jobId; }).slice().sort(_bldgNumSort);
            var names = [];
            phases.forEach(function(p) { var n = p.phase || 'Unnamed'; if (names.indexOf(n) === -1) names.push(n); });
            names.sort();
            if (!names.length || !buildings.length) { container.innerHTML = ''; return; }
            // Local attribute escaper — jobs.js has no escapeAttr, and using an
            // undefined one silently threw (empty matrix). Quote-safe for the
            // data-* attrs + input values below.
            var attr = function(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
            var cols = buildings.map(function(b) { return { id: b.id, name: b.name || 'Building' }; });
            var colTot = {}, colCost = {}; cols.forEach(function(c) { colTot[c.id] = 0; colCost[c.id] = 0; }); var unTot = 0, unCost = 0, grand = 0, grandCost = 0;
            var poAccr = (typeof getJobPOAccrued === 'function') ? getJobPOAccrued(jobId).byPhase : {};
            var stickL = 'position:sticky;left:0;background:var(--card-bg,#141419);z-index:1;';
            var stickLSel = 'position:sticky;left:0;background:rgba(59,95,163,0.20);z-index:1;';
            // Phase-first selection state (drives the Link toolbar below).
            var selPhaseCount = names.filter(function(n) { return _mxPhaseSel[n]; }).length;
            var selBldgCount = buildings.filter(function(b) { return _mxSel[b.id]; }).length;
            var allPhasesTicked = names.length > 0 && selPhaseCount === names.length;

            var head = '<tr><th style="text-align:left;padding:5px 8px;font-size:11px;color:var(--text-dim);' + stickL + '">' +
                '<label style="display:inline-flex;align-items:center;gap:5px;cursor:pointer;" title="Select all / no scopes">' +
                    '<input type="checkbox"' + (allPhasesTicked ? ' checked' : '') + ' onchange="onMxTogglePhaseAll(this)" style="cursor:pointer;margin:0;"/>Scope</label></th>';
            cols.forEach(function(c) { head += '<th style="text-align:right;padding:5px 8px;font-size:11px;color:var(--text-dim);white-space:nowrap;">' +
                '<label style="display:inline-flex;align-items:center;gap:3px;cursor:pointer;justify-content:flex-end;" title="Tick buildings to link the selected scopes to (leave all unticked = every building)">' +
                    '<input type="checkbox"' + (_mxSel[c.id] ? ' checked' : '') + ' data-mx-bcol="' + attr(c.id) + '" onchange="onMxToggleBldgSel(this)" style="cursor:pointer;margin:0;"/>' +
                    escapeHTML(c.name) +
                '</label></th>'; });
            head += '<th style="text-align:right;padding:5px 8px;font-size:11px;color:var(--text-dim);">Unassigned</th>';
            head += '<th style="text-align:right;padding:5px 8px;font-size:11px;color:var(--accent);">Total</th>';
            head += '<th style="text-align:right;padding:5px 8px;font-size:11px;color:var(--text-dim);border-left:1px solid var(--border);">Cost</th>';
            head += '<th style="text-align:right;padding:5px 8px;font-size:11px;color:var(--text-dim);">Profit</th>';
            head += '<th style="text-align:right;padding:5px 8px;font-size:11px;color:var(--text-dim);">% Done</th></tr>';

            function pctCell(name, bid, pct, auto) {
                return '<td style="text-align:right;padding:3px 4px;"><span style="display:inline-flex;align-items:center;gap:1px;">' +
                    '<input type="number" min="0" max="100" step="1" value="' + (pct != null ? Math.round(pct * 10) / 10 : '') + '" ' +
                    'data-mx-phase="' + attr(name) + '" data-mx-bldg="' + attr(bid || '') + '" oninput="onPhaseMatrixPctCell(this)" onchange="onPhaseMatrixCommit(this)" ' +
                    'title="' + (auto ? 'Auto-split — type to override' : 'Manual override') + '" ' +
                    'style="width:50px;font-size:12px;padding:3px 4px;text-align:right;background:var(--bg);border:1px ' + (auto ? 'dashed' : 'solid') + ' var(--border);border-radius:4px;color:var(--text' + (auto ? '-dim' : '') + ');"/>' +
                    '<span style="font-size:10px;color:var(--text-dim);">%</span></span></td>';
            }
            function dollarCell(name, bid, v, dashed) {
                return '<td style="text-align:right;padding:3px 4px;"><input type="number" min="0" step="100" value="' + (v || '') + '" ' +
                    'data-mx-phase="' + attr(name) + '" data-mx-bldg="' + attr(bid || '') + '" oninput="onPhaseMatrixCell(this)" onchange="onPhaseMatrixCommit(this)" ' +
                    'style="width:76px;font-size:12px;padding:3px 5px;text-align:right;background:var(--bg);border:1px ' + (dashed ? 'dashed' : 'solid') + ' var(--border);border-radius:4px;color:var(--text' + (dashed ? '-dim' : '') + ');"/></td>';
            }

            var body = names.map(function(name) {
                var info = phaseAllocInfo(jobId, name);
                var isPct = info.mode === 'pct';
                var shares = isPct ? phasePctShares(jobId, name).shares : null;
                var rowTot = 0;
                var recCost = function(r) { return r ? (r.materials || 0) + (r.labor || 0) + (r.sub || 0) + (r.equipment || 0) : 0; };
                var cells = cols.map(function(c) {
                    var rec = info.recs.find(function(r) { return (r.buildingId || null) === c.id; });
                    var d = phaseDollar(rec); colTot[c.id] += d; rowTot += d; colCost[c.id] += recCost(rec);
                    if (isPct) { var sh = shares[c.id] || { pct: 0, auto: true }; return pctCell(name, c.id, sh.pct, sh.auto); }
                    return dollarCell(name, c.id, d, false);
                }).join('');
                var urec = info.recs.find(function(r) { return !(r.buildingId); });
                var ud = phaseDollar(urec); unTot += ud; rowTot += ud; unCost += recCost(urec);
                var unSh = isPct ? (shares['__un__'] || { pct: 0, auto: true }) : null;
                var unCell = isPct ? pctCell(name, null, unSh.pct, unSh.auto) : dollarCell(name, null, ud, true);
                grand += rowTot;
                // Fold-in of the legacy Phase table: cost / profit / progress per phase.
                var pcost = info.recs.reduce(function(s, r) { return s + recCost(r); }, 0); grandCost += pcost;
                var pprofit = rowTot - pcost;
                var avgPct = info.recs.length ? Math.round(info.recs.reduce(function(s, r) { return s + (r.pctComplete || 0); }, 0) / info.recs.length) : 0;
                var modeChip = '<button type="button" data-mx-phase="' + attr(name) + '" onclick="onPhaseMatrixModeToggle(this)" title="Toggle percent / dollar allocation for this scope" style="margin-left:6px;font-size:10px;font-weight:700;padding:1px 6px;border-radius:10px;border:1px solid var(--border);background:var(--overlay-light,rgba(255,255,255,0.05));color:var(--accent);cursor:pointer;">' + (isPct ? '%' : '$') + '</button>';
                var accrChip = (poAccr[name] > 0) ? '<span title="Open PO commitment — accrued until billed/paid" style="margin-left:6px;font-size:10px;padding:1px 6px;border-radius:10px;background:rgba(224,164,88,0.15);color:var(--orange,#e0a458);white-space:nowrap;">&#9203; ' + formatCurrency(poAccr[name]) + '</span>' : '';
                var totalCell = isPct
                    ? '<td style="text-align:right;padding:3px 4px;"><input type="number" min="0" step="100" value="' + (info.total || '') + '" data-mx-phase="' + attr(name) + '" oninput="onPhaseMatrixTotal(this)" onchange="onPhaseMatrixCommit(this)" placeholder="total $" style="width:90px;font-size:12.5px;font-weight:700;padding:3px 5px;text-align:right;background:var(--bg);border:1px solid var(--accent);border-radius:4px;color:var(--accent);font-family:monospace;"/></td>'
                    : '<td data-mx-rowtot="' + attr(name) + '" style="text-align:right;padding:4px 8px;font-size:12.5px;font-weight:700;color:var(--accent);font-family:monospace;">' + formatCurrency(rowTot) + '</td>';
                var costCell = '<td style="text-align:right;padding:4px 8px;font-size:12px;font-family:monospace;color:var(--orange,#e0a458);border-left:1px solid var(--border);">' + formatCurrency(pcost) + '</td>';
                var profitCell = '<td style="text-align:right;padding:4px 8px;font-size:12px;font-family:monospace;color:' + (pprofit >= 0 ? 'var(--green)' : 'var(--red)') + ';">' + formatCurrency(pprofit) + '</td>';
                var doneCell = '<td style="text-align:right;padding:3px 4px;"><span style="display:inline-flex;align-items:center;gap:1px;justify-content:flex-end;"><input type="number" min="0" max="100" step="5" value="' + (avgPct || '') + '" data-mx-phase="' + attr(name) + '" oninput="onPhaseMatrixPctDone(this)" onchange="onPhaseMatrixCommit(this)" title="Scope % complete — drives the WIP roll-up" style="width:46px;font-size:12px;padding:3px 4px;text-align:right;background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--accent);font-weight:700;"/><span style="font-size:10px;color:var(--text-dim);">%</span></span></td>';
                var phaseChk = '<input type="checkbox"' + (_mxPhaseSel[name] ? ' checked' : '') + ' data-mx-prow="' + attr(name) + '" onchange="onMxTogglePhaseSel(this)" title="Select this scope to link to buildings" style="cursor:pointer;margin:0 6px 0 0;vertical-align:middle;"/>';
                var pCellStick = _mxPhaseSel[name] ? stickLSel : stickL;
                return '<tr>' +
                    '<td style="text-align:left;padding:4px 8px;font-size:12.5px;font-weight:600;color:var(--text);white-space:nowrap;' + pCellStick + '">' + phaseChk + escapeHTML(name) + modeChip + accrChip + '</td>' +
                    cells + unCell + totalCell + costCell + profitCell + doneCell + '</tr>';
            }).join('');

            var foot = '<tr style="border-top:2px solid var(--border);"><td style="text-align:left;padding:5px 8px;font-size:11px;font-weight:700;color:var(--text-dim);' + stickL + '">Building revenue</td>';
            cols.forEach(function(c) { foot += '<td data-mx-coltot="' + attr(c.id) + '" style="text-align:right;padding:5px 8px;font-size:12px;font-weight:700;font-family:monospace;">' + formatCurrency(colTot[c.id]) + '</td>'; });
            foot += '<td data-mx-coltot="__un__" style="text-align:right;padding:5px 8px;font-size:12px;font-weight:700;font-family:monospace;color:var(--text-dim);">' + formatCurrency(unTot) + '</td>';
            foot += '<td data-mx-grand style="text-align:right;padding:5px 8px;font-size:13px;font-weight:800;font-family:monospace;color:var(--accent);">' + formatCurrency(grand) + '</td>';
            foot += '<td style="text-align:right;padding:5px 8px;font-size:12px;font-weight:800;font-family:monospace;color:var(--orange,#e0a458);border-left:1px solid var(--border);">' + formatCurrency(grandCost) + '</td>';
            foot += '<td style="text-align:right;padding:5px 8px;font-size:12px;font-weight:800;font-family:monospace;color:' + ((grand - grandCost) >= 0 ? 'var(--green)' : 'var(--red)') + ';">' + formatCurrency(grand - grandCost) + '</td>';
            foot += '<td></td></tr>';
            // Second footer row — per-building cost (folds the legacy Building table's Spent column).
            foot += '<tr><td style="text-align:left;padding:4px 8px;font-size:11px;color:var(--text-dim);' + stickL + '">Building cost</td>';
            cols.forEach(function(c) { foot += '<td style="text-align:right;padding:4px 8px;font-size:11.5px;font-family:monospace;color:var(--orange,#e0a458);">' + formatCurrency(colCost[c.id]) + '</td>'; });
            foot += '<td style="text-align:right;padding:4px 8px;font-size:11.5px;font-family:monospace;color:var(--text-dim);">' + formatCurrency(unCost) + '</td>';
            foot += '<td></td><td></td><td></td><td></td></tr>';

            var linkTarget = selBldgCount ? (selBldgCount + ' building' + (selBldgCount === 1 ? '' : 's')) : 'all buildings';
            var actionZone = selPhaseCount
                ? '<button type="button" onclick="onPhaseMatrixLinkSelected(this)" title="Distribute each selected scope across ' + (selBldgCount ? 'the selected buildings' : 'every building') + ', split by units/levels" style="font-size:11px;font-weight:700;padding:5px 12px;border-radius:8px;border:1px solid var(--accent);background:var(--accent);color:#fff;cursor:pointer;white-space:nowrap;">&#128279; Link ' + selPhaseCount + ' scope' + (selPhaseCount === 1 ? '' : 's') + ' &rarr; ' + linkTarget + '</button>'
                : '<span style="font-size:11px;color:var(--text-dim);">Tick <b>scopes</b> (left) + <b>buildings</b> (headers), then <b>Link</b> — each scope splits across the buildings by units/levels. Untick all buildings to link to every one. Type any cell to override; the [% / $] chip toggles a row.</span>';
            container.innerHTML =
                '<div style="display:flex;justify-content:space-between;align-items:center;margin:2px 0 6px;gap:8px;flex-wrap:wrap;">' +
                    '<h4 style="font-size:12px;margin:0;color:var(--text-dim);text-transform:uppercase;letter-spacing:.5px;">Scopes &times; Buildings</h4>' +
                    actionZone +
                '</div>' +
                '<div style="border:1px solid var(--border,#333);border-radius:10px;overflow-x:auto;background:var(--card-bg,#141419);margin-bottom:12px;">' +
                    '<table style="width:100%;border-collapse:collapse;"><thead>' + head + '</thead><tbody>' + body + '</tbody><tfoot>' + foot + '</tfoot></table>' +
                '</div>';
        }

        // ── Building-first phase allocation editor ──────────────────────────
        // One card per phase. On a phase you tick the SET of buildings it
        // touches (or "All") in one shot, choose how to split (Even / by Units /
        // by Levels), and — if needed — override any building's share. This is
        // the primary allocation surface; the wide Buildings×Phases matrix is
        // still available via the Cards/Grid toggle. All writes go through the
        // SAME primitives the matrix uses (spreadPhaseCore + commitMatrixChange
        // for building coverage / split; the onPhaseMatrix* per-field handlers
        // for total / % / %-done / mode), so the math + persistence are shared.
        var _allocView = {}; // jobId -> 'cards' | 'grid' (default cards)

        // Buildings a phase currently covers: it has an auto share, a positive
        // manual %, or positive dollars on that (phase,building) record.
        function allocCoveredSet(jobId, name) {
            var out = {};
            (appData.phases || []).filter(function(p) {
                return p.jobId === jobId && (p.phase || 'Unnamed') === name && p.buildingId;
            }).forEach(function(r) {
                if (r.allocAuto === true || (r.allocPct != null && r.allocPct > 0) || phaseDollar(r) > 0) out[r.buildingId] = 1;
            });
            return out;
        }

        function renderPhaseAllocEditorInto(container, jobId) {
            if (!container) return;
            dedupePhaseRecords(jobId); // self-heal orphan-twin phase records before painting
            var phases = (appData.phases || []).filter(function(p) { return p.jobId === jobId; });
            var buildings = (appData.buildings || []).filter(function(b) { return b.jobId === jobId; }).slice().sort(_bldgNumSort);
            var names = [];
            phases.forEach(function(p) { var n = p.phase || 'Unnamed'; if (names.indexOf(n) === -1) names.push(n); });
            names.sort();
            if (!names.length || !buildings.length) { container.innerHTML = ''; return; }
            var attr = function(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
            var poAccr = (typeof getJobPOAccrued === 'function') ? getJobPOAccrued(jobId).byPhase : {};
            var recCost = function(r) { return r ? (r.materials || 0) + (r.labor || 0) + (r.sub || 0) + (r.equipment || 0) : 0; };

            var cards = names.map(function(name) {
                var info = phaseAllocInfo(jobId, name);
                var isPct = info.mode === 'pct';
                var shares = isPct ? phasePctShares(jobId, name).shares : null;
                var covered = allocCoveredSet(jobId, name);
                var coveredCount = Object.keys(covered).length;
                var rev = info.recs.reduce(function(s, r) { return s + phaseDollar(r); }, 0);
                var cost = info.recs.reduce(function(s, r) { return s + recCost(r); }, 0);
                var profit = rev - cost;
                var avgPct = info.recs.length ? Math.round(info.recs.reduce(function(s, r) { return s + (r.pctComplete || 0); }, 0) / info.recs.length) : 0;
                var splitPref = 'units'; info.recs.forEach(function(r) { if (r.allocSplit) splitPref = r.allocSplit; });

                // Per-building share % (for the meter + share list).
                function bldgPct(bid) {
                    if (isPct) { var sh = shares[bid]; return sh ? (sh.pct || 0) : 0; }
                    var r = info.recs.find(function(x) { return (x.buildingId || null) === bid; });
                    return (info.sumDollars > 0 && r) ? (phaseDollar(r) / info.sumDollars * 100) : 0;
                }
                var bldgPctSum = 0; buildings.forEach(function(b) { if (covered[b.id]) bldgPctSum += bldgPct(b.id); });
                var allocRounded = Math.round(bldgPctSum);
                var hasBudget = ((info.total || 0) > 0) || (info.sumDollars > 0);
                // Green ✓ requires an actual budget to allocate — a $0 phase with
                // buildings ticked is 100% of nothing, not "fully allocated".
                var meterOk = hasBudget && coveredCount > 0 && allocRounded >= 99 && allocRounded <= 101;
                var meterColor = meterOk ? 'var(--green)' : ((coveredCount === 0 || !hasBudget) ? 'var(--text-dim)' : 'var(--orange,#e0a458)');
                var meterText = coveredCount === 0 ? 'No buildings assigned'
                    : (!hasBudget ? 'No budget set'
                    : ('Allocated ' + allocRounded + '%' + (meterOk ? ' ✓' : ' ⚠')));

                // ── Header: name + mode chip + accrued + Rev/Cost/Profit + %Done
                var modeChip = '<button type="button" data-mx-phase="' + attr(name) + '" onclick="onPhaseMatrixModeToggle(this)" title="Toggle percent / dollar allocation for this scope" style="font-size:10px;font-weight:700;padding:1px 7px;border-radius:10px;border:1px solid var(--border);background:var(--overlay-light,rgba(255,255,255,0.05));color:var(--accent);cursor:pointer;">' + (isPct ? '%' : '$') + '</button>';
                var accrChip = (poAccr[name] > 0) ? '<span title="Open PO commitment — accrued until billed/paid" style="font-size:10px;padding:1px 6px;border-radius:10px;background:rgba(224,164,88,0.15);color:var(--orange,#e0a458);white-space:nowrap;">&#9203; ' + formatCurrency(poAccr[name]) + '</span>' : '';
                var header =
                    '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-bottom:8px;">' +
                        '<div style="display:flex;align-items:center;gap:7px;flex-wrap:wrap;">' +
                            '<span style="font-size:14px;font-weight:700;color:var(--text);">' + escapeHTML(name) + '</span>' + modeChip + accrChip +
                        '</div>' +
                        '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;font-size:11.5px;font-family:monospace;">' +
                            '<span style="color:var(--text-dim);">Rev <b style="color:var(--green);">' + formatCurrency(rev) + '</b></span>' +
                            '<span style="color:var(--text-dim);">Cost <b style="color:var(--orange,#e0a458);">' + formatCurrency(cost) + '</b></span>' +
                            '<span style="color:var(--text-dim);">Profit <b style="color:' + (profit >= 0 ? 'var(--green)' : 'var(--red)') + ';">' + formatCurrency(profit) + '</b></span>' +
                            '<span style="display:inline-flex;align-items:center;gap:2px;color:var(--text-dim);">% Done <input type="number" min="0" max="100" step="5" value="' + (avgPct || '') + '" data-mx-phase="' + attr(name) + '" oninput="onPhaseMatrixPctDone(this)" onchange="onPhaseMatrixCommit(this)" title="Scope % complete — drives the WIP roll-up" style="width:44px;font-size:12px;padding:2px 4px;text-align:right;background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--accent);font-weight:700;"/></span>' +
                        '</div>' +
                    '</div>';

                // ── Budget row: editable total in % mode; sum read-out in $ mode
                var budgetRow =
                    '<div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:9px;">' +
                        '<div style="display:flex;align-items:center;gap:6px;">' +
                            '<span style="font-size:11px;color:var(--text-dim);text-transform:uppercase;letter-spacing:.4px;">Budget</span>' +
                            (isPct
                                ? '<input type="number" min="0" step="100" value="' + (info.total || '') + '" data-mx-phase="' + attr(name) + '" oninput="onPhaseMatrixTotal(this)" onchange="onPhaseMatrixCommit(this)" placeholder="total $" style="width:110px;font-size:13px;font-weight:700;padding:3px 6px;text-align:right;background:var(--bg);border:1px solid var(--accent);border-radius:5px;color:var(--accent);font-family:monospace;"/>'
                                : '<span style="font-size:13px;font-weight:700;color:var(--accent);font-family:monospace;">' + formatCurrency(info.sumDollars) + '</span>') +
                        '</div>' +
                        '<div style="display:flex;align-items:center;gap:5px;">' +
                            '<span style="font-size:11px;color:var(--text-dim);text-transform:uppercase;letter-spacing:.4px;">Split</span>' +
                            ['even', 'units', 'levels'].map(function(sp) {
                                var on = splitPref === sp;
                                return '<button type="button" data-ap-phase="' + attr(name) + '" data-ap-split="' + sp + '" onclick="onAllocSplit(this)" ' + (isPct ? '' : 'disabled ') +
                                    'title="Split the budget across the assigned buildings ' + (sp === 'even' ? 'evenly' : 'by each building\'s ' + sp) + '" ' +
                                    'style="font-size:11px;font-weight:600;text-transform:capitalize;padding:3px 9px;border:1px solid ' + (on ? 'var(--accent)' : 'var(--border)') + ';border-radius:12px;cursor:' + (isPct ? 'pointer' : 'not-allowed') + ';background:' + (on ? 'var(--accent)' : 'transparent') + ';color:' + (on ? '#fff' : 'var(--text-dim)') + ';opacity:' + (isPct ? '1' : '.5') + ';">' + sp + '</button>';
                            }).join('') +
                        '</div>' +
                    '</div>';

                // ── Building multi-select chips (ticked = covered) + All / Clear
                // Coverage changes re-split the budget (a %-mode operation), so
                // in $ mode the chips + All/Clear are disabled — same as the
                // Split buttons — to avoid silently flipping the phase to % and
                // wiping hand-typed dollar amounts. Switch to % to re-assign.
                var canAssign = isPct;
                var allOn = coveredCount === buildings.length && buildings.length > 0;
                var chips = buildings.map(function(b) {
                    var on = !!covered[b.id];
                    return '<button type="button" data-ap-phase="' + attr(name) + '" data-ap-bldg="' + attr(b.id) + '" onclick="onAllocToggleBldg(this)" ' + (canAssign ? '' : 'disabled ') +
                        'title="' + (canAssign ? (on ? 'Remove from this phase' : 'Add to this phase') : 'Switch to % mode to change which buildings are on this phase') + '" ' +
                        'style="font-size:11.5px;font-weight:600;padding:4px 10px;border-radius:14px;border:1px solid ' + (on ? 'var(--accent)' : 'var(--border)') + ';cursor:' + (canAssign ? 'pointer' : 'not-allowed') + ';white-space:nowrap;background:' + (on ? 'var(--accent)' : 'var(--overlay-light,rgba(255,255,255,0.04))') + ';color:' + (on ? '#fff' : 'var(--text-dim)') + ';opacity:' + (canAssign ? '1' : '.55') + ';">' +
                        (on ? '✓ ' : '') + escapeHTML(b.name || 'Building') + '</button>';
                }).join('');
                var quickChips =
                    '<button type="button" data-ap-phase="' + attr(name) + '" data-ap-which="all" onclick="onAllocAllBldgs(this)" ' + (canAssign ? '' : 'disabled ') + 'title="Assign every building" style="font-size:11px;font-weight:700;padding:4px 10px;border-radius:14px;border:1px dashed ' + (allOn ? 'var(--accent)' : 'var(--border)') + ';cursor:' + (canAssign ? 'pointer' : 'not-allowed') + ';background:transparent;color:' + (allOn ? 'var(--accent)' : 'var(--text-dim)') + ';opacity:' + (canAssign ? '1' : '.55') + ';">All</button>' +
                    '<button type="button" data-ap-phase="' + attr(name) + '" data-ap-which="none" onclick="onAllocAllBldgs(this)" ' + (canAssign ? '' : 'disabled ') + 'title="Unassign all buildings" style="font-size:11px;font-weight:700;padding:4px 10px;border-radius:14px;border:1px dashed var(--border);cursor:' + (canAssign ? 'pointer' : 'not-allowed') + ';background:transparent;color:var(--text-dim);opacity:' + (canAssign ? '1' : '.55') + ';">Clear</button>';
                var chipHint = canAssign ? '' : '<div style="font-size:10.5px;color:var(--text-dim);margin-top:5px;">Switch to <b>%</b> mode (chip above) to change which buildings are on this phase.</div>';
                var chipRow =
                    '<div style="margin-bottom:9px;">' +
                        '<div style="font-size:11px;color:var(--text-dim);text-transform:uppercase;letter-spacing:.4px;margin-bottom:5px;">Buildings on this phase</div>' +
                        '<div style="display:flex;flex-wrap:wrap;gap:6px;">' + chips + '<span style="width:1px;background:var(--border);margin:0 2px;"></span>' + quickChips + '</div>' + chipHint +
                    '</div>';

                // ── Per-building shares (covered only): % or $ input + read-out
                var shareBldgs = buildings.filter(function(b) { return covered[b.id]; });
                var shareRows = '';
                if (shareBldgs.length) {
                    shareRows = '<div style="display:flex;flex-wrap:wrap;gap:6px 14px;margin-bottom:9px;">' + shareBldgs.map(function(b) {
                        var rec = info.recs.find(function(r) { return (r.buildingId || null) === b.id; });
                        var d = phaseDollar(rec);
                        var sh = isPct ? (shares[b.id] || { pct: 0, auto: true }) : { pct: bldgPct(b.id), auto: false };
                        var input = isPct
                            ? '<input type="number" min="0" max="100" step="1" value="' + (sh.pct != null ? Math.round(sh.pct * 10) / 10 : '') + '" data-mx-phase="' + attr(name) + '" data-mx-bldg="' + attr(b.id) + '" oninput="onPhaseMatrixPctCell(this)" onchange="onPhaseMatrixCommit(this)" title="' + (sh.auto ? 'Auto — type to override' : 'Manual override') + '" style="width:52px;font-size:12px;padding:2px 5px;text-align:right;background:var(--bg);border:1px ' + (sh.auto ? 'dashed' : 'solid') + ' var(--border);border-radius:4px;color:var(--text' + (sh.auto ? '-dim' : '') + ');"/><span style="font-size:10px;color:var(--text-dim);">%</span>'
                            : '<input type="number" min="0" step="100" value="' + (d || '') + '" data-mx-phase="' + attr(name) + '" data-mx-bldg="' + attr(b.id) + '" oninput="onPhaseMatrixCell(this)" onchange="onPhaseMatrixCommit(this)" style="width:82px;font-size:12px;padding:2px 5px;text-align:right;background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--text);font-family:monospace;"/>';
                        return '<span style="display:inline-flex;align-items:center;gap:5px;padding:2px 0;">' +
                            '<span style="font-size:12px;color:var(--text);min-width:0;">' + escapeHTML(b.name || 'Building') + '</span>' +
                            input +
                            '<span style="font-size:11px;color:var(--text-dim);font-family:monospace;">' + formatCurrency(d) + '</span>' +
                        '</span>';
                    }).join('') + '</div>';
                }

                // ── Allocation meter
                var meter =
                    '<div style="display:flex;align-items:center;gap:6px;font-size:11.5px;">' +
                        '<span style="width:8px;height:8px;border-radius:50%;background:' + meterColor + ';display:inline-block;"></span>' +
                        '<span style="color:' + meterColor + ';font-weight:600;">' + meterText + '</span>' +
                        (isPct ? '' : '<span style="color:var(--text-dim);margin-left:4px;">(dollar mode — type each building\'s amount)</span>') +
                    '</div>';

                return '<div style="border:1px solid var(--border,#333);border-radius:12px;background:var(--card-bg,#141419);padding:12px 14px;margin-bottom:10px;">' +
                    header + budgetRow + chipRow + shareRows + meter +
                '</div>';
            }).join('');

            container.innerHTML = cards;
        }

        // Toggle one building in/out of a phase's covered set → re-spread across
        // the resulting set (units/levels/even by the phase's split), then commit.
        function onAllocToggleBldg(el) {
            var name = el && el.getAttribute && el.getAttribute('data-ap-phase');
            var bid = el && el.getAttribute && el.getAttribute('data-ap-bldg');
            var jobId = (typeof appState !== 'undefined' && appState.currentJobId);
            if (!name || !bid || !jobId) return;
            // spreadPhaseCore re-splits (a %-mode op). Never run it on a $-mode
            // phase — the chips are disabled there, but guard against any stray
            // call so hand-typed dollar amounts can't be silently wiped.
            if (phaseAllocInfo(jobId, name).mode !== 'pct') return;
            var covered = allocCoveredSet(jobId, name);
            if (covered[bid]) delete covered[bid]; else covered[bid] = 1;
            spreadPhaseCore(jobId, name, Object.keys(covered));
            commitMatrixChange(jobId, null); // null host → skip matrix; p86RerenderJobCards repaints the cards
        }
        window.onAllocToggleBldg = onAllocToggleBldg;

        // All / Clear the phase's building coverage.
        function onAllocAllBldgs(el) {
            var name = el && el.getAttribute && el.getAttribute('data-ap-phase');
            var which = el && el.getAttribute && el.getAttribute('data-ap-which');
            var jobId = (typeof appState !== 'undefined' && appState.currentJobId);
            if (!name || !jobId) return;
            if (phaseAllocInfo(jobId, name).mode !== 'pct') return; // %-mode op only (see onAllocToggleBldg)
            var buildings = (appData.buildings || []).filter(function(b) { return b.jobId === jobId; });
            var targetIds = (which === 'none') ? [] : buildings.map(function(b) { return b.id; });
            spreadPhaseCore(jobId, name, targetIds);
            commitMatrixChange(jobId, null);
        }
        window.onAllocAllBldgs = onAllocAllBldgs;

        // Change how a phase's budget splits across its buildings (even / units /
        // levels). Stamp allocSplit on the phase's records, drop manual overrides
        // by re-spreading over the current covered set, then commit.
        function onAllocSplit(el) {
            var name = el && el.getAttribute && el.getAttribute('data-ap-phase');
            var split = el && el.getAttribute && el.getAttribute('data-ap-split');
            var jobId = (typeof appState !== 'undefined' && appState.currentJobId);
            if (!name || !split || !jobId) return;
            if (phaseAllocInfo(jobId, name).mode !== 'pct') return; // %-mode op only (see onAllocToggleBldg)
            (appData.phases || []).filter(function(p) { return p.jobId === jobId && (p.phase || 'Unnamed') === name; })
                .forEach(function(r) { r.allocSplit = split; });
            var covered = Object.keys(allocCoveredSet(jobId, name));
            if (covered.length) spreadPhaseCore(jobId, name, covered); // re-weight the auto shares
            commitMatrixChange(jobId, null);
        }
        window.onAllocSplit = onAllocSplit;

        // Flip the phase surface between the card editor and the wide matrix
        // grid. Repaint BOTH possible hosts: the node-graph inspector
        // (#insp-phases, via p86RerenderJobCards) and the classic overview
        // (#job-phases-cards, via renderJobPhases) — only one exists per route.
        function onAllocViewToggle(which) {
            var jobId = (typeof appState !== 'undefined' && appState.currentJobId);
            if (!jobId) return;
            _allocView[jobId] = which;
            try { if (typeof p86RerenderJobCards === 'function') p86RerenderJobCards(jobId); } catch (e) {}
            try { if (typeof renderJobPhases === 'function') renderJobPhases(jobId); } catch (e) {}
        }
        window.onAllocViewToggle = onAllocViewToggle;

        // ── Contract → phase budget bridge + reconciliation ─────────────────
        // The job carries a single CONTRACT number; the phases are where that
        // money is budgeted (and then spreads to buildings). Nothing bridged the
        // two, so freshly-imported jobs showed $0 everywhere. These helpers
        // surface the gap ("$X of $Y allocated") and let the GC fill it in one
        // click, then adjust each phase.
        function getJobContractTotal(jobId) {
            var job = (appData.jobs || []).find(function(j) { return j.id === jobId; });
            return job ? (job.contractAmount || 0) : 0;
        }
        // Dollars of a phase that have actually LANDED on buildings (its
        // building-assigned records only — money parked on the job-level
        // "Unassigned" record does NOT count as reaching a building).
        function getPhaseLandedOnBuildings(jobId, name) {
            return (appData.phases || []).reduce(function(s, p) {
                if (p.jobId === jobId && (p.phase || 'Unnamed') === name && p.buildingId) return s + phaseRevenue(p);
                return s;
            }, 0);
        }
        // ONE canonical reconciliation, so the Phases strip and the Buildings
        // summary can never disagree: "allocated" = the budget that actually
        // reaches buildings (= Σ buildingEffectiveBudget, the same figure the
        // buildings table sums). The ±tolerance absorbs per-building cent
        // rounding (bounded by ~$0.50/building) and can never mask a real gap —
        // the smallest real shortfall is an unbudgeted phase (thousands).
        function getJobBudgetRecon(jobId) {
            var contract = getJobContractTotal(jobId);
            var buildings = (appData.buildings || []).filter(function(b) { return b.jobId === jobId; });
            var onBuildings = buildings.reduce(function(s, b) { return s + buildingEffectiveBudget(b, jobId).amount; }, 0);
            var unassigned = (appData.phases || []).reduce(function(s, p) {
                return (p.jobId === jobId && !p.buildingId) ? s + phaseRevenue(p) : s;
            }, 0);
            var gap = contract - onBuildings;
            var tol = Math.max(1, buildings.length);
            return {
                contract: contract, onBuildings: onBuildings, unassigned: unassigned, gap: gap,
                full: Math.abs(gap) <= tol, over: gap < -tol, hasBuildings: buildings.length > 0
            };
        }
        // Even-fill the UNALLOCATED contract across the phases that haven't
        // reached buildings yet, then spread each across all buildings
        // (units/levels-weighted). Whole-dollar largest-remainder so the sums
        // reconcile. Non-destructive to already-landed phases; a no-buildings
        // job can't land anything, so it no-ops (the button is hidden there).
        // Every dollar a scope already carries, wherever it sits: spread across
        // buildings OR parked on the job-level Unassigned record. A scope with a
        // hand-entered job-level budget is NOT an empty scope.
        function getPhaseBudgetTotal(jobId, name) {
            return (appData.phases || []).reduce(function(s, p) {
                if (p.jobId === jobId && (p.phase || 'Unnamed') === name) return s + phaseRevenue(p);
                return s;
            }, 0);
        }
        function distributeContractToPhases(jobId) {
            var recon = getJobBudgetRecon(jobId);
            if (recon.contract <= 0) return { ok: false, reason: 'no-contract' };
            if (!recon.hasBuildings) return { ok: false, reason: 'no-buildings' };
            var names = [];
            (appData.phases || []).forEach(function(p) { if (p.jobId === jobId) { var n = p.phase || 'Unnamed'; if (names.indexOf(n) === -1) names.push(n); } });
            // Fill only what NO scope has claimed yet, and only into scopes that
            // are genuinely empty. Previously this used recon.gap (= contract −
            // onBuildings, which ignores the `unassigned` figure recon computes
            // but never subtracts) and treated "not yet on a building" as empty
            // — so a scope budgeted at the job level looked unclaimed twice over
            // and got overwritten by the even split. On Fairways that turned a
            // hand-entered Gutters $92,000 into $120,067/$120,066.
            var claimed = names.reduce(function(s, n) { return s + getPhaseBudgetTotal(jobId, n); }, 0);
            var remaining = recon.contract - claimed;
            if (remaining <= 0.5) return { ok: false, reason: 'fully-allocated' };
            var fillable = names.filter(function(n) { return getPhaseBudgetTotal(jobId, n) <= 0.5; });
            if (!fillable.length) return { ok: false, reason: 'no-fillable-phases' }; // under-allocated but every phase is on buildings → GC adjusts a phase
            // Whole-dollar largest-remainder split so the per-phase budgets sum
            // EXACTLY to the (rounded) remaining, no fractional drift.
            var whole = Math.round(remaining);
            var base = Math.floor(whole / fillable.length);
            var extra = whole - base * fillable.length; // first `extra` phases get +$1
            var bldgIds = (appData.buildings || []).filter(function(b) { return b.jobId === jobId; }).map(function(b) { return b.id; });
            fillable.forEach(function(name, i) {
                var share = base + (i < extra ? 1 : 0);
                (appData.phases || []).filter(function(p) { return p.jobId === jobId && (p.phase || 'Unnamed') === name; })
                    .forEach(function(r) { r.allocMode = 'pct'; r.phaseAllocTotal = share; });
                spreadPhaseCore(jobId, name, bldgIds); // reads phaseAllocTotal (set above) as the amount
            });
            commitMatrixChange(jobId, null);
            return { ok: true, filled: fillable.length, total: whole };
        }
        function onDistributeContract(el) {
            var jobId = (typeof appState !== 'undefined' && appState.currentJobId);
            if (!jobId) return;
            distributeContractToPhases(jobId);
        }
        window.onDistributeContract = onDistributeContract;

        // Edit a matrix cell → find-or-create the (phase, building) record,
        // write its as-sold budget slice, persist, and live-update the totals.
        function onPhaseMatrixCell(input) {
            var name = input.getAttribute('data-mx-phase');
            var bid = input.getAttribute('data-mx-bldg') || null;
            var jobId = (typeof appState !== 'undefined' && appState.currentJobId);
            if (!name || !jobId) return;
            var val = parseFloat(input.value) || 0;
            var rec = appData.phases.find(function(p) { return p.jobId === jobId && (p.phase || 'Unnamed') === name && (p.buildingId || null) === (bid || null); });
            if (!rec) {
                if (val === 0) return;
                rec = { id: 'p' + Date.now() + Math.floor(Math.random() * 1000), jobId: jobId, buildingId: bid,
                    phase: name, workScope: 'in-house', locked: false, pctComplete: 0,
                    materials: 0, labor: 0, sub: 0, equipment: 0,
                    asSoldRevenue: 0, asSoldPhaseBudget: 0, coPhaseBudget: 0, phaseBudget: 0,
                    hoursWeek: 0, hoursTotal: 0, rate: 40, notes: '' };
                appData.phases.push(rec);
            }
            rec.asSoldPhaseBudget = val;
            rec.phaseBudget = val + (rec.coPhaseBudget || 0);
            // Matrix = source of truth: mirror the cell into the phase's as-sold
            // REVENUE, not just its budget. The graph's WIP roll-up weights each
            // phase by revenue — leaving this at 0 was why the job % never totaled.
            rec.asSoldRevenue = val;
            // If this edit emptied the "Unassigned" bucket while buildings hold the
            // phase, drop the remnant so it never lingers as a $0 job-level row.
            pruneEmptyUnassignedPhases(jobId);
            if (typeof saveData === 'function') saveData();
            recomputePhaseMatrixTotals(input, jobId);
        }
        window.onPhaseMatrixCell = onPhaseMatrixCell;

        // % -mode cell (oninput): record the building's % override; the dollar
        // recompute + rebalance of the auto cells happens on commit (blur).
        function onPhaseMatrixPctCell(input) {
            var name = input.getAttribute('data-mx-phase'), bid = input.getAttribute('data-mx-bldg') || null;
            var jobId = (typeof appState !== 'undefined' && appState.currentJobId);
            if (!name || !jobId) return;
            var val = parseFloat(input.value); if (isNaN(val) || val < 0) val = 0; if (val > 100) val = 100;
            var rec = phaseRecFor(jobId, name, bid);
            rec.allocMode = 'pct'; rec.allocPct = val; rec.allocAuto = false;
        }
        window.onPhaseMatrixPctCell = onPhaseMatrixPctCell;

        // % -mode total (oninput): record the phase total that the shares divide.
        function onPhaseMatrixTotal(input) {
            var name = input.getAttribute('data-mx-phase');
            var jobId = (typeof appState !== 'undefined' && appState.currentJobId);
            if (!name || !jobId) return;
            var val = parseFloat(input.value) || 0;
            (appData.phases || []).filter(function(p) { return p.jobId === jobId && (p.phase || 'Unnamed') === name; })
                .forEach(function(r) { r.allocMode = 'pct'; r.phaseAllocTotal = val; });
        }
        window.onPhaseMatrixTotal = onPhaseMatrixTotal;

        // Programmatic equivalents of the grid's inline handlers, for allocation
        // surfaces that aren't the grid (the Site Plan's Contract allocation
        // card). They run the SAME primitives and persistence — a second
        // implementation of allocation math is precisely what this rework exists
        // to delete, so nothing here recomputes dollars on its own.
        function setScopeTotal(jobId, name, amount) {
            if (!jobId || !name) return false;
            var recs = (appData.phases || []).filter(function(p) { return p.jobId === jobId && (p.phase || 'Unnamed') === name; });
            if (!recs.length) return false;
            var val = Number(amount); if (!isFinite(val) || val < 0) val = 0;
            recs.forEach(function(r) { r.allocMode = 'pct'; r.phaseAllocTotal = val; });
            recomputePhasePctAllocation(jobId, name);   // largest-remainder → cells sum exactly
            pruneEmptyUnassignedPhases(jobId);
            if (typeof saveData === 'function') saveData();
            return true;
        }
        window.setScopeTotal = setScopeTotal;
        function setScopeBuildingPct(jobId, name, bldgId, pct) {
            if (!jobId || !name) return false;
            var v = Number(pct); if (!isFinite(v) || v < 0) v = 0; if (v > 100) v = 100;
            var rec = phaseRecFor(jobId, name, bldgId || null);
            rec.allocMode = 'pct'; rec.allocPct = v; rec.allocAuto = false;
            recomputePhasePctAllocation(jobId, name);
            pruneEmptyUnassignedPhases(jobId);
            if (typeof saveData === 'function') saveData();
            return true;
        }
        window.setScopeBuildingPct = setScopeBuildingPct;
        // Exposed for the allocation card's "+ Scope" / "+ Building" actions.
        window.openAddPhaseToJobModal = openAddPhaseToJobModal;
        window.openAddBuildingToJobModal = openAddBuildingToJobModal;

        // % -Done cell (oninput): set every record of the phase to this % complete
        // (a phase progresses as a unit); the graph sync + WIP roll-up run on commit.
        function onPhaseMatrixPctDone(input) {
            var name = input.getAttribute('data-mx-phase');
            var jobId = (typeof appState !== 'undefined' && appState.currentJobId);
            if (!name || !jobId) return;
            var val = parseFloat(input.value); if (isNaN(val) || val < 0) val = 0; if (val > 100) val = 100;
            (appData.phases || []).filter(function(p) { return p.jobId === jobId && (p.phase || 'Unnamed') === name; })
                .forEach(function(r) { r.pctComplete = val; r.pctCompleteManual = true; });
        }
        window.onPhaseMatrixPctDone = onPhaseMatrixPctDone;

        // Flip a phase row between % and $ allocation. Switching to % seeds the
        // total + each building's % from the current dollars so nothing moves;
        // switching to $ just leaves the dollars in place.
        function onPhaseMatrixModeToggle(el) {
            var name = el && el.getAttribute && el.getAttribute('data-mx-phase');
            var jobId = (typeof appState !== 'undefined' && appState.currentJobId);
            if (!name || !jobId) return;
            var info = phaseAllocInfo(jobId, name);
            var newMode = info.mode === 'pct' ? 'dollar' : 'pct';
            if (newMode === 'pct') {
                var total = info.sumDollars;
                info.recs.forEach(function(r) {
                    r.allocMode = 'pct';
                    r.phaseAllocTotal = total;
                    r.allocPct = total > 0 ? (phaseDollar(r) / total * 100) : null;
                    r.allocAuto = total > 0 ? false : true; // preserve existing split; even-split when empty
                });
            } else {
                info.recs.forEach(function(r) { r.allocMode = 'dollar'; });
            }
            if (typeof saveData === 'function') saveData();
            // Repaint BOTH hosts: the node-graph inspector (#insp-phases, via
            // p86RerenderJobCards) and the classic overview (#job-phases-cards,
            // via renderJobPhases). renderJobPhases alone was a no-op on the Site
            // Map route (#job-phases-cards isn't mounted there), so the mode chip
            // looked dead in the inspector — the card + matrix both live there.
            try { if (typeof p86RerenderJobCards === 'function') p86RerenderJobCards(jobId); } catch (e) {}
            if (typeof renderJobPhases === 'function') renderJobPhases(jobId);
        }
        window.onPhaseMatrixModeToggle = onPhaseMatrixModeToggle;

        // Commit (blur) for any matrix input: in % mode, resolve the shares →
        // dollars; then push each wired phase node's revenue + recompute the job
        // roll-up + repaint — but only once focus leaves the grid, so tabbing
        // across cells for rapid entry isn't interrupted. Matrix-side twin of
        // p86CommitInline.
        function onPhaseMatrixCommit(input) {
            var name = input.getAttribute('data-mx-phase');
            var jobId = (typeof appState !== 'undefined' && appState.currentJobId);
            if (!name || !jobId) return;
            var info = phaseAllocInfo(jobId, name);
            if (info.mode === 'pct') recomputePhasePctAllocation(jobId, name);
            if (typeof saveData === 'function') saveData();
            if (typeof NG !== 'undefined') {
                try {
                    var recs = (appData.phases || []).filter(function(p) { return p.jobId === jobId && (p.phase || 'Unnamed') === name; });
                    var byId = {}; recs.forEach(function(r) { byId[r.id] = r; });
                    NG.nodes().forEach(function(n) { if (n.type === 't2' && n.data && byId[n.data.id]) { var r = byId[n.data.id]; n.revenue = phaseDollar(r); n.pct = r.pctComplete || 0; n.pctComplete = r.pctComplete || 0; } });
                    NG.saveGraph();
                } catch (e) {}
            }
            setTimeout(function() {
                var ae = document.activeElement;
                if (ae && ae.getAttribute && ae.getAttribute('data-mx-phase') != null) return; // still in the grid
                try { if (typeof ensureNGComputed === 'function') ensureNGComputed(jobId); } catch (e) {}
                try { if (typeof p86RerenderJobCards === 'function') p86RerenderJobCards(jobId); } catch (e) {}
                try { if (typeof renderJobPhases === 'function') renderJobPhases(jobId); } catch (e) {}
            }, 60);
        }
        window.onPhaseMatrixCommit = onPhaseMatrixCommit;
        window.onPhaseMatrixCellCommit = onPhaseMatrixCommit; // legacy alias

        // Multi-select: toggle a building into the matrix selection, then re-render
        // so each phase's "→ sel (N)" button appears/updates.
        function onMxToggleBldgSel(el) {
            var bid = el && el.getAttribute && el.getAttribute('data-mx-bcol'); if (!bid) return;
            if (el.checked) _mxSel[bid] = true; else delete _mxSel[bid];
            var host = el.closest ? el.closest('.phase-matrix-host') : null;
            var jobId = (typeof appState !== 'undefined' && appState.currentJobId);
            if (host && jobId) { try { renderPhaseMatrixInto(host, jobId); } catch (e) {} }
        }
        window.onMxToggleBldgSel = onMxToggleBldgSel;

        // ---- Buildings×Phases bulk linking --------------------------------
        // Core: put ONE phase in % mode with the TARGET buildings auto (units/
        // levels-weighted share via phasePctShares) and every OTHER building +
        // Unassigned pinned to an explicit 0 — so the whole phase lands on the
        // targets. Mutates appData ONLY; the caller runs commitMatrixChange once
        // (a bulk link over many phases must not save + recompute + repaint per
        // phase).
        function spreadPhaseCore(jobId, name, targetIds) {
            var buildings = (appData.buildings || []).filter(function(b) { return b.jobId === jobId; });
            var tset = {}; (targetIds || []).forEach(function(id) { tset[id] = 1; });
            var info = phaseAllocInfo(jobId, name);
            var total = info.total || info.sumDollars || 0;
            buildings.forEach(function(b) {
                var rec = phaseRecFor(jobId, name, b.id);
                rec.allocMode = 'pct'; rec.phaseAllocTotal = total;
                if (tset[b.id]) { rec.allocPct = null; rec.allocAuto = true; }
                else { rec.allocPct = 0; rec.allocAuto = false; setPhaseDollar(rec, 0); }
            });
            var urec = (appData.phases || []).find(function(p) { return p.jobId === jobId && (p.phase || 'Unnamed') === name && !p.buildingId; });
            if (urec) { urec.allocMode = 'pct'; urec.phaseAllocTotal = total; urec.allocPct = 0; urec.allocAuto = false; setPhaseDollar(urec, 0); }
            recomputePhasePctAllocation(jobId, name);
        }

        // Shared post-change tail: persist, re-sync EVERY wired t2 phase node's
        // revenue/pct from its record (a bulk link touches many phases), save the
        // graph, then re-render the matrix + roll-up cards.
        function commitMatrixChange(jobId, host) {
            dedupePhaseRecords(jobId); // collapse any orphan-twin recs so the heal persists
            if (typeof saveData === 'function') saveData();
            if (typeof NG !== 'undefined') {
                try {
                    var recs = (appData.phases || []).filter(function(p) { return p.jobId === jobId; });
                    var byId = {}; recs.forEach(function(r) { byId[r.id] = r; });
                    NG.nodes().forEach(function(n) { if (n.type === 't2' && n.data && byId[n.data.id]) { var r = byId[n.data.id]; n.revenue = phaseDollar(r); n.pct = r.pctComplete || 0; n.pctComplete = r.pctComplete || 0; } });
                    NG.saveGraph();
                } catch (e) {}
            }
            if (host) { try { renderPhaseMatrixInto(host, jobId); } catch (e) {} }
            try { if (typeof ensureNGComputed === 'function') ensureNGComputed(jobId); } catch (e) {}
            try { if (typeof p86RerenderJobCards === 'function') p86RerenderJobCards(jobId); } catch (e) {}
            try { if (typeof renderJobPhases === 'function') renderJobPhases(jobId); } catch (e) {}
        }

        // Single-phase spread — kept for programmatic use (el carries data-mx-phase
        // + data-mx-spread 'all'|'sel'). The UI drives the bulk path below.
        function onPhaseMatrixSpread(el) {
            var name = el && el.getAttribute && el.getAttribute('data-mx-phase');
            var mode = el && el.getAttribute && el.getAttribute('data-mx-spread');
            var jobId = (typeof appState !== 'undefined' && appState.currentJobId);
            if (!name || !jobId) return;
            var buildings = (appData.buildings || []).filter(function(b) { return b.jobId === jobId; });
            var targetIds = (mode === 'sel')
                ? buildings.filter(function(b) { return _mxSel[b.id]; }).map(function(b) { return b.id; })
                : buildings.map(function(b) { return b.id; });
            if (!targetIds.length) return;
            spreadPhaseCore(jobId, name, targetIds);
            commitMatrixChange(jobId, el.closest ? el.closest('.phase-matrix-host') : null);
        }
        window.onPhaseMatrixSpread = onPhaseMatrixSpread;

        // Toggle one phase-row's selection (checkbox in the Phase column).
        function onMxTogglePhaseSel(el) {
            var name = el && el.getAttribute && el.getAttribute('data-mx-prow'); if (name == null) return;
            if (el.checked) _mxPhaseSel[name] = true; else delete _mxPhaseSel[name];
            var host = el.closest ? el.closest('.phase-matrix-host') : null;
            var jobId = (typeof appState !== 'undefined' && appState.currentJobId);
            if (host && jobId) { try { renderPhaseMatrixInto(host, jobId); } catch (e) {} }
        }
        window.onMxTogglePhaseSel = onMxTogglePhaseSel;

        // Select-all / none phases (checkbox in the Phase header).
        function onMxTogglePhaseAll(el) {
            var jobId = (typeof appState !== 'undefined' && appState.currentJobId); if (!jobId) return;
            var names = []; (appData.phases || []).forEach(function(p) { if (p.jobId === jobId) { var n = p.phase || 'Unnamed'; if (names.indexOf(n) === -1) names.push(n); } });
            _mxPhaseSel = {};
            if (el && el.checked) names.forEach(function(n) { _mxPhaseSel[n] = true; });
            var host = el.closest ? el.closest('.phase-matrix-host') : null;
            if (host) { try { renderPhaseMatrixInto(host, jobId); } catch (e) {} }
        }
        window.onMxTogglePhaseAll = onMxTogglePhaseAll;

        // Bulk phase-first link: distribute EVERY selected phase across the
        // selected buildings (or ALL buildings when none are ticked), each split
        // weighted by units/levels. Pick phases, pick buildings, one click.
        function onPhaseMatrixLinkSelected(el) {
            var jobId = (typeof appState !== 'undefined' && appState.currentJobId); if (!jobId) return;
            var buildings = (appData.buildings || []).filter(function(b) { return b.jobId === jobId; });
            var selNames = Object.keys(_mxPhaseSel).filter(function(n) { return _mxPhaseSel[n]; });
            if (!selNames.length) return;
            var selBldgIds = buildings.filter(function(b) { return _mxSel[b.id]; }).map(function(b) { return b.id; });
            var targetIds = selBldgIds.length ? selBldgIds : buildings.map(function(b) { return b.id; });
            if (!targetIds.length) return;
            selNames.forEach(function(name) { spreadPhaseCore(jobId, name, targetIds); });
            _mxPhaseSel = {}; // clear phase selection after linking (keep building ticks)
            var host = el && el.closest ? el.closest('.phase-matrix-host') : document.querySelector('.phase-matrix-host');
            commitMatrixChange(jobId, host);
        }
        window.onPhaseMatrixLinkSelected = onPhaseMatrixLinkSelected;
        // Exposed so the Site Plan's Contract allocation card can mount the SAME
        // matrix instead of keeping a second, node-graph-local allocation model.
        window.renderPhaseMatrixInto = renderPhaseMatrixInto;

        function recomputePhaseMatrixTotals(input, jobId) {
            var table = input.closest('table'); if (!table) return;
            var phases = (appData.phases || []).filter(function(p) { return p.jobId === jobId; });
            function sum(pred) { return phases.filter(pred).reduce(function(s, p) { return s + (p.asSoldPhaseBudget || p.phaseBudget || 0); }, 0); }
            table.querySelectorAll('[data-mx-rowtot]').forEach(function(td) {
                var name = td.getAttribute('data-mx-rowtot');
                td.textContent = formatCurrency(sum(function(p) { return (p.phase || 'Unnamed') === name; }));
            });
            table.querySelectorAll('[data-mx-coltot]').forEach(function(td) {
                var bid = td.getAttribute('data-mx-coltot');
                var pred = (bid === '__un__') ? function(p) { return !p.buildingId; } : function(p) { return p.buildingId === bid; };
                td.textContent = formatCurrency(sum(pred));
            });
            var g = table.querySelector('[data-mx-grand]');
            if (g) g.textContent = formatCurrency(sum(function() { return true; }));
        }

        function renderJobPhases(jobId) {
            const phases = appData.phases.filter(p => p.jobId === jobId);
            const container = document.getElementById('job-phases-cards');
            if (container) renderOverviewPhasesInto(container, jobId, phases);
        }

        function renderOverviewSubsInto(container, jobId, subs) {
            container.innerHTML = '';

            const titleHTML = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">' +
                '<h3 style="font-size:13px;margin:0;">&#x1F477; Subcontractors (' + subs.length + ')</h3>' +
                '<div id="' + container.id + '-totals" style="font-size:12px;color:var(--text-dim);"></div>' +
                '</div>';

            if (subs.length === 0) {
                container.innerHTML = titleHTML +
                    '<div style="padding:12px;text-align:center;color:var(--text-dim);font-size:12px;">No subcontractors yet.</div>';
                return;
            }

            const ARROW_RIGHT = '▶';
            const ARROW_DOWN = '▼';
            let totalContract = 0, totalBilled = 0;

            const rowsHTML = subs.map(function(sub) {
                const contract = sub.contractAmt || 0;
                const billed = sub.billedToDate || 0;
                const remaining = contract - billed;
                const pctBilled = contract > 0 ? ((billed / contract) * 100).toFixed(1) : '0.0';
                totalContract += contract;
                totalBilled += billed;

                const conns = getNodeGraphConnections('sub', sub.id);
                const uid = 'sub-grp-' + sub.id.replace(/\W/g, '_');
                const arrowId = uid + '-arrow';

                const summaryRow =
                    '<tr class="sub-row" style="cursor:pointer;user-select:none;border-bottom:1px solid var(--overlay-light,rgba(255,255,255,0.04));" ' +
                        'onclick="(function(){var d=document.getElementById(\'' + uid + '\');var a=document.getElementById(\'' + arrowId + '\');var closed=d.style.display===\'none\';d.style.display=closed?\'table-row\':\'none\';var open=closed;a.textContent=open?\'' + ARROW_DOWN + '\':\'' + ARROW_RIGHT + '\';})()">' +
                        '<td style="white-space:nowrap;padding:6px 10px;">' +
                            '<span id="' + arrowId + '" style="font-size:10px;color:var(--text-dim);display:inline-block;width:10px;">' + ARROW_RIGHT + '</span> ' +
                            '<strong style="color:var(--text,#fff);font-size:13px;">' + escapeHTML(sub.name) + '</strong>' +
                            (conns.length > 0 ? '<span style="margin-left:6px;font-size:10px;padding:1px 6px;border-radius:10px;background:rgba(79,140,255,0.15);color:var(--accent);">' + conns.length + ' node' + (conns.length > 1 ? 's' : '') + '</span>' : '') +
                        '</td>' +
                        '<td style="white-space:nowrap;padding:6px 10px;font-size:12px;color:var(--text-dim,#aaa);">' +
                            escapeHTML(sub.trade || '') +
                        '</td>' +
                        '<td class="num" style="text-align:right;white-space:nowrap;padding:6px 10px;font-family:\'SF Mono\',monospace;font-size:13px;color:var(--accent);font-weight:600;">' +
                            formatCurrency(contract) +
                        '</td>' +
                        '<td class="num" style="text-align:right;white-space:nowrap;padding:6px 10px;font-family:\'SF Mono\',monospace;font-size:13px;color:var(--green);font-weight:600;">' +
                            formatCurrency(billed) +
                        '</td>' +
                        '<td class="num" style="text-align:right;white-space:nowrap;padding:6px 10px;font-family:\'SF Mono\',monospace;font-size:13px;color:var(--orange);font-weight:600;">' +
                            formatCurrency(remaining) +
                        '</td>' +
                        '<td class="num" style="text-align:right;white-space:nowrap;padding:6px 10px;font-family:\'SF Mono\',monospace;font-size:12px;color:var(--text-dim,#aaa);">' +
                            pctBilled + '%' +
                        '</td>' +
                        '<td style="white-space:nowrap;padding:6px 10px;text-align:right;">' +
                            '<button class="ee-btn ghost" style="font-size:11px;padding:3px 8px;" onclick="event.stopPropagation();editSub(\'' + escapeHTML(sub.id) + '\')">&#x270F;&#xFE0F; Edit</button>' +
                        '</td>' +
                    '</tr>';

                let body = '<tr id="' + uid + '" class="sub-body" style="display:none;"><td colspan="7" style="padding:10px 14px;background:var(--surface2);border-bottom:1px solid var(--border,#333);">';
                if (sub.notes) {
                    body += '<div style="font-size:11px;color:var(--text-dim);margin-bottom:8px;">' + escapeHTML(sub.notes) + '</div>';
                }
                body += '<div style="font-size:12px;font-weight:600;color:var(--text-dim);margin-bottom:6px;">Site Plan Connections</div>';
                if (conns.length === 0) {
                    body += '<div style="font-size:11px;color:var(--text-dim);font-style:italic;">Not placed on graph yet</div>';
                } else {
                    conns.forEach(function(c, i) {
                        var wireDesc = [];
                        c.targets.forEach(function(t) { wireDesc.push('<span style="color:var(--green);">&rarr; ' + escapeHTML(t.label) + '</span>'); });
                        c.sources.forEach(function(s) { wireDesc.push('<span style="color:var(--accent);">' + escapeHTML(s.label) + ' &rarr;</span>'); });
                        body += '<div style="padding:4px 8px;margin:3px 0;background:var(--surface);border-radius:4px;font-size:11px;display:flex;align-items:center;gap:8px;">' +
                            '<span style="color:var(--purple);font-weight:600;">Instance #' + (i + 1) + '</span>' +
                            (wireDesc.length ? wireDesc.join(' ') : '<span style="color:var(--text-dim);">Unconnected</span>') +
                            '</div>';
                    });
                }
                body += '</td></tr>';
                return summaryRow + body;
            }).join('');

            container.innerHTML = titleHTML +
                '<div style="border:1px solid var(--border,#333);border-radius:10px;overflow-x:auto;background:var(--card-bg,#141419);">' +
                    '<table style="width:100%;border-collapse:collapse;table-layout:auto;">' +
                        '<thead style="background:var(--overlay-light,rgba(255,255,255,0.02));border-bottom:1px solid var(--border,#333);"><tr>' +
                            thCell('Subcontractor', 'left') +
                            thCell('Trade', 'left') +
                            thCell('Contract', 'right') +
                            thCell('Billed', 'right') +
                            thCell('Remaining', 'right') +
                            thCell('% Billed', 'right') +
                            thCell('', 'right') +
                        '</tr></thead>' +
                        '<tbody>' + rowsHTML + '</tbody>' +
                    '</table>' +
                '</div>';

            // Inline totals in section header
            const totalRemaining = totalContract - totalBilled;
            const totalsEl = document.getElementById(container.id + '-totals');
            if (totalsEl) {
                totalsEl.innerHTML = 'Contract: <b style="color:var(--accent);">' + formatCurrency(totalContract) +
                    '</b> &nbsp; Billed: <b style="color:var(--green);">' + formatCurrency(totalBilled) +
                    '</b> &nbsp; Rem: <b style="color:var(--orange);">' + formatCurrency(totalRemaining) + '</b>';
            }
        }

        function renderJobSubs(jobId) {
            const subs = appData.subs.filter(s => s.jobId === jobId);
            const container = document.getElementById('job-subs-cards');
            if (container) renderOverviewSubsInto(container, jobId, subs);
        }

        function renderJobLabor(jobId) {
            const phases = appData.phases.filter(p => p.jobId === jobId);
            const tbody = document.querySelector('#job-labor-table tbody');
            tbody.innerHTML = '';

            phases.forEach(p => {
                const building = appData.buildings.find(b => b.id === p.buildingId);
                const laborCost = p.labor || 0;
                const computedLabor = (p.hoursTotal || 0) * (p.rate || 40);

                const row = document.createElement('tr');
                row.innerHTML = `
                    <td>${escapeHTML(building?.name) || ''}</td>
                    <td>${escapeHTML(p.phase)}</td>
                    <td style="text-align: right;">${p.hoursWeek || 0}</td>
                    <td style="text-align: right;">${p.hoursTotal || 0}</td>
                    <td style="text-align: right;">${formatCurrency(p.rate || 40)}</td>
                    <td style="text-align: right;">${formatCurrency(laborCost)}</td>
                    <td style="text-align: right;">${formatCurrency(computedLabor)}</td>
                `;
                tbody.appendChild(row);
            });
        }

        // renderJobWeekly retired — Thursday WIP Meeting Accruals were a manual
        // weekly capture workflow. Daily auto-snapshots (3 AM EST) replace the
        // need for it. Per-phase weeklyMat/weeklyLabor/weeklySub/weeklyEquip
        // fields are no longer set on new phases.

        // renderJobCosts / saveJobCosts / updateJobCostSummary retired
        // along with the Costs sub-tab — labor cost flows from QuickBooks
        // through the hourly-burden node and the five cost-category
        // boxes are now driven by node-graph cost buckets via
        // set_node_value, so the legacy direct-input UI was redundant.

        function getJobContractAmount() {
            const job = appData.jobs.find(j => j.id === appState.currentJobId);
            return job ? (job.contractAmount || 0) : 0;
        }

        function syncBuildingBudgetFromPct() {
            syncBuildingBudgetFromDollar();
        }

        function syncBuildingBudgetFromDollar() {
            const dollars = parseFloat(document.getElementById('buildingBudget').value) || 0;
            const allBldgs = appData.buildings.filter(b => b.jobId === appState.currentJobId);
            const editId = appState.editBuildingId;
            const otherBudget = allBldgs.reduce(function(s, b) {
                return s + (b.id === editId ? 0 : (b.budget || 0));
            }, 0);
            const total = otherBudget + dollars;
            const pct = total > 0 ? (dollars / total * 100) : 0;
            document.getElementById('buildingBudgetPct').value = pct.toFixed(1);
            const coBudget = editId ? (allBldgs.find(b => b.id === editId)?.coBudget || 0) : 0;
            var hint = pct.toFixed(1) + '% of job (' + formatCurrency(total) + ' total)';
            if (coBudget) hint += ' \u00b7 includes ' + formatCurrency(coBudget) + ' from COs';
            document.getElementById('buildingBudgetHint').textContent = hint;
            updatePhaseBreakdownRemaining();
        }

        function openAddBuildingToJobModal() {
            appState.editBuildingId = null;
            document.getElementById('buildingModalHeader').textContent = 'Add Building';
            document.getElementById('saveBuildingBtn').innerHTML = '&#x1F3D7; Add Building';
            document.getElementById('deleteBuildingBtn').style.display = 'none';
            document.getElementById('buildingName').value = '';
            document.getElementById('buildingBudgetPct').value = '';
            document.getElementById('buildingBudget').value = '';
            document.getElementById('buildingBudgetHint').textContent = 'Contract: ' + formatCurrency(getJobContractAmount());
            document.getElementById('buildingAddress').value = '';
            document.getElementById('buildingMaterials').value = '';
            document.getElementById('buildingLabor').value = '';
            document.getElementById('buildingSub').value = '0.00';
            document.getElementById('buildingEquipment').value = '';
            document.getElementById('buildingHoursWeek').value = '';
            document.getElementById('buildingHoursTotal').value = '';
            document.getElementById('buildingRate').value = '40';
            document.getElementById('buildingWorkScope').value = 'in-house';
            document.getElementById('buildingLocked').checked = false;
            document.getElementById('buildingExcludeSubDist').checked = false;
            document.getElementById('buildingPhaseBreakdown').style.display = 'none';
            openModal('addBuildingModal');
        }

        function editBuilding(buildingId) {
            const building = appData.buildings.find(b => b.id === buildingId);
            if (!building) return;

            appState.editBuildingId = buildingId;
            document.getElementById('buildingModalHeader').textContent = 'Edit Building';
            document.getElementById('saveBuildingBtn').innerHTML = '&#x1F4BE; Save Changes';
            document.getElementById('deleteBuildingBtn').style.display = 'inline-block';
            document.getElementById('buildingName').value = building.name || '';
            document.getElementById('buildingBudget').value = building.asSoldBudget || building.budget || '';
            document.getElementById('buildingAddress').value = building.address || '';
            document.getElementById('buildingMaterials').value = building.materials || '';
            document.getElementById('buildingLabor').value = building.labor || '';
            document.getElementById('buildingSub').value = getSubCostForBuilding(building.id, building.jobId || appState.currentJobId).toFixed(2);
            document.getElementById('buildingEquipment').value = building.equipment || '';
            document.getElementById('buildingHoursWeek').value = '';
            document.getElementById('buildingHoursTotal').value = building.hoursTotal || '';
            document.getElementById('buildingRate').value = building.rate || 40;

            syncBuildingBudgetFromDollar();
            document.getElementById('buildingWorkScope').value = building.workScope || 'in-house';
            document.getElementById('buildingLocked').checked = building.locked || false;
            document.getElementById('buildingExcludeSubDist').checked = building.excludeFromSubDist || false;
            renderBuildingPhaseBreakdown(buildingId);
            renderBuildingCOBreakdown(buildingId);
            openModal('addBuildingModal');
        }

        function renderBuildingPhaseBreakdown(buildingId) {
            const wrap = document.getElementById('buildingPhaseBreakdown');
            const rowsEl = document.getElementById('bldgPhaseRows');
            if (!buildingId) { wrap.style.display = 'none'; return; }
            const phases = appData.phases.filter(p => p.buildingId === buildingId);
            if (phases.length === 0 && !appState.editBuildingId) { wrap.style.display = 'none'; return; }
            wrap.style.display = 'block';
            rowsEl.innerHTML = '';

            phases.forEach(function(p) {
                const asSold = p.asSoldPhaseBudget || p.phaseBudget || 0;
                const co = p.coPhaseBudget || 0;
                const total = asSold + co;
                const row = document.createElement('div');
                row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid var(--border);';
                // Accidental-edit gate — row starts locked so the autosave
                // oninput on the budget input can't fire until the user
                // taps the row to arm it. Delete button stays clickable
                // via data-edit-gate-passthrough.
                row.setAttribute('data-row-edit-gate', '');
                row.setAttribute('data-editing', 'false');
                row.innerHTML =
                    '<span style="flex:1;font-size:13px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escapeHTML(p.phase) +
                    ' <span style="font-size:10px;color:' + (p.pctComplete >= 100 ? 'var(--green)' : p.pctComplete >= 50 ? '#f59e0b' : 'var(--text-dim)') + ';">' + (p.pctComplete||0) + '%</span></span>' +
                    '<input type="text" inputmode="decimal" data-phase-id="' + p.id + '" value="' + asSold + '" style="width:110px;font-size:12px;padding:4px 6px;background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--text);text-align:right;" oninput="onPhaseBreakdownInput(this)">' +
                    (co ? '<span style="font-size:10px;color:var(--green);white-space:nowrap;">+' + formatCurrency(co) + ' CO</span>' : '') +
                    '<span style="font-size:12px;font-weight:600;color:var(--accent);width:90px;text-align:right;">' + formatCurrency(total) + '</span>' +
                    '<button type="button" data-edit-gate-passthrough onclick="removePhaseFromBreakdown(\'' + p.id + '\')" style="background:none;border:none;color:var(--red);cursor:pointer;font-size:14px;padding:2px 4px;" title="Delete phase">&times;</button>';
                rowsEl.appendChild(row);
            });

            // Wire the edit gate once per render. Idempotent — internal
            // WeakSet de-dupes across renders. Cleared rows lose the
            // listener naturally when rowsEl.innerHTML is reset.
            if (window.p86EditGate) {
                window.p86EditGate.attachRowContainer(rowsEl, '[data-row-edit-gate]');
            }

            updatePhaseBreakdownRemaining();
        }

        function onPhaseBreakdownInput(input) {
            const phaseId = input.getAttribute('data-phase-id');
            const phase = appData.phases.find(p => p.id === phaseId);
            if (!phase) return;
            const val = parseFloat(input.value) || 0;
            phase.asSoldPhaseBudget = val;
            phase.phaseBudget = val + (phase.coPhaseBudget || 0);
            phase.asSoldRevenue = val; // mirror — keep revenue == as-sold budget (matrix = source of truth)
            const totalSpan = input.parentElement.querySelector('span[style*="width:90px"]');
            if (totalSpan) totalSpan.textContent = formatCurrency(phase.phaseBudget);
            updatePhaseBreakdownRemaining();
        }

        function updatePhaseBreakdownRemaining() {
            const el = document.getElementById('bldgPhaseRemaining');
            if (!el || !appState.editBuildingId) return;
            const bldgBudget = parseFloat(document.getElementById('buildingBudget').value) || 0;
            const phases = appData.phases.filter(p => p.buildingId === appState.editBuildingId);
            const allocated = phases.reduce((s, p) => s + (p.asSoldPhaseBudget || p.phaseBudget || 0), 0);
            const remaining = bldgBudget - allocated;
            el.textContent = 'Allocated: ' + formatCurrency(allocated) + ' · Remaining: ' + formatCurrency(remaining);
            el.style.color = remaining < 0 ? 'var(--red)' : remaining === 0 ? 'var(--green)' : 'var(--yellow)';
        }

        // p86Prompt, not native prompt() — the native one no-ops in an installed
        // PWA, so "add scope" did nothing there.
        function addPhaseFromBuildingModal() {
            if (!appState.editBuildingId) return;
            var ask = (typeof window.p86Prompt === 'function')
                ? window.p86Prompt({ title: 'Add scope', message: 'Scope name', placeholder: 'e.g. Paint, Gutters, Roofing' })
                : Promise.resolve(window.prompt('Scope name (e.g. Paint, Gutters):'));
            Promise.resolve(ask).then(function (phaseName) {
                if (!phaseName || !String(phaseName).trim()) return;
                _addPhaseFromBuildingConfirmed(String(phaseName).trim());
            });
        }
        function _addPhaseFromBuildingConfirmed(phaseName) {
            const phase = {
                id: 'p' + Date.now(),
                jobId: appState.currentJobId,
                buildingId: appState.editBuildingId,
                phase: phaseName.trim(),
                workScope: 'in-house',
                locked: false,
                pctComplete: 0,
                materials: 0, labor: 0, sub: 0, equipment: 0,
                asSoldPhaseBudget: 0,
                coPhaseBudget: 0,
                phaseBudget: 0,
                hoursWeek: 0, hoursTotal: 0, rate: 40,
                notes: ''
            };
            appData.phases.push(phase);
            if (typeof saveData === 'function') saveData();   // was never persisted on its own
            renderBuildingPhaseBreakdown(appState.editBuildingId);
        }

        // Create a JOB-LEVEL phase (not pinned to a building) — the job-first
        // model: set the phase total on the job, then split it across buildings
        // in the breakdown/matrix. buildingId=null marks it unassigned/job-level.
        // Uses a modal (native prompt() no-ops in the installed PWA).
        function addJobLevelPhase(jobId) {
            jobId = jobId || (typeof appState !== 'undefined' && appState.currentJobId);
            if (!jobId) return;
            var back = document.createElement('div');
            back.style.cssText = 'position:fixed;inset:0;z-index:2147483200;background:rgba(6,9,17,.6);display:flex;align-items:center;justify-content:center;padding:16px;';
            back.innerHTML =
                '<div class="modal-content" style="width:min(430px,96vw);">' +
                    '<div class="p86-dialog-title">Add job-level phase</div>' +
                    '<div class="p86-dialog-message">Create a phase on the job and set its total. You then split it across buildings in the breakdown.</div>' +
                    '<label style="display:block;font-size:12px;margin:10px 0 4px;">Phase name</label>' +
                    '<input class="p86-dialog-input" id="jlpName" type="text" placeholder="e.g. Roofing, Framing, Sitework" />' +
                    '<div style="display:flex;gap:10px;">' +
                        '<div style="flex:1;"><label style="display:block;font-size:12px;margin:12px 0 4px;">Budget / cost ($)</label>' +
                        '<input class="p86-dialog-input" id="jlpBudget" type="number" min="0" step="100" placeholder="0" /></div>' +
                        '<div style="flex:1;"><label style="display:block;font-size:12px;margin:12px 0 4px;">Revenue ($)</label>' +
                        '<input class="p86-dialog-input" id="jlpRev" type="number" min="0" step="100" placeholder="0" /></div>' +
                    '</div>' +
                    '<div class="p86-dialog-actions" style="margin-top:16px;">' +
                        '<button class="p86-dialog-btn" data-cancel>Cancel</button>' +
                        '<button class="p86-dialog-btn p86-dialog-btn-primary" data-create>Add phase</button>' +
                    '</div>' +
                '</div>';
            document.body.appendChild(back);
            function close() { if (back.parentNode) back.parentNode.removeChild(back); }
            back.addEventListener('click', function(e) { if (e.target === back) close(); });
            back.querySelector('[data-cancel]').addEventListener('click', close);
            back.querySelector('[data-create]').addEventListener('click', function() {
                var name = (back.querySelector('#jlpName').value || '').trim();
                if (!name) { back.querySelector('#jlpName').focus(); return; }
                var budget = parseFloat(back.querySelector('#jlpBudget').value) || 0;
                var revenue = parseFloat(back.querySelector('#jlpRev').value) || 0;
                var phase = {
                    id: 'p' + Date.now(),
                    jobId: jobId,
                    buildingId: null,                 // job-level — split to buildings in the matrix
                    phase: name,
                    workScope: 'in-house',
                    locked: false,
                    pctComplete: 0,
                    materials: 0, labor: 0, sub: 0, equipment: 0,
                    asSoldRevenue: revenue,
                    asSoldPhaseBudget: budget,
                    coPhaseBudget: 0,
                    phaseBudget: budget,
                    hoursWeek: 0, hoursTotal: 0, rate: 40,
                    notes: ''
                };
                if (!Array.isArray(appData.phases)) appData.phases = [];
                appData.phases.push(phase);
                if (typeof saveData === 'function') saveData();
                close();
                // Re-render the overview Phases section (Site Plan right panel).
                var host = document.getElementById('insp-phases');
                if (host) { try { renderOverviewPhasesInto(host, jobId, appData.phases.filter(function(p) { return p.jobId === jobId; })); } catch (e) {} }
                if (typeof window.p86Toast === 'function') window.p86Toast('Phase "' + name + '" added at the job level', 'success');
            });
            setTimeout(function() { var i = back.querySelector('#jlpName'); if (i) i.focus(); }, 0);
        }
        window.addJobLevelPhase = addJobLevelPhase;

        function removePhaseFromBreakdown(phaseId) {
            _confirmDelete('scope', { message: 'Remove this scope from the building?' }).then(function (ok) {
                if (!ok) return;
                appData.phases = appData.phases.filter(p => p.id !== phaseId);
                renderBuildingPhaseBreakdown(appState.editBuildingId);
            });
        }

        function cosForBuilding(buildingId) {
            if (!buildingId) return [];
            const phaseIds = appData.phases.filter(p => p.buildingId === buildingId).map(p => p.id);
            return appData.changeOrders.filter(function(c) {
                if (!c.allocations || !c.allocations.length) return false;
                return c.allocations.some(function(a) {
                    return a.buildingId === buildingId || (a.phaseId && phaseIds.indexOf(a.phaseId) > -1);
                });
            });
        }

        function renderBuildingCOBreakdown(buildingId) {
            const wrap = document.getElementById('buildingCOBreakdown');
            const rowsEl = document.getElementById('bldgCORows');
            if (!wrap || !rowsEl) return;
            if (!buildingId) { wrap.style.display = 'none'; return; }
            wrap.style.display = 'block';
            rowsEl.innerHTML = '';
            const cos = cosForBuilding(buildingId);
            if (cos.length === 0) {
                rowsEl.innerHTML = '<div style="font-size:12px;color:var(--text-dim);padding:6px 2px;">No change orders linked to this building yet.</div>';
            }
            cos.forEach(function(co) {
                const inc = co.income || 0;
                const cost = co.estimatedCosts || 0;
                const row = document.createElement('div');
                row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid var(--border);';
                // Accidental-edit gate — locks the income + cost inputs
                // until the user taps the row. Delete stays clickable.
                row.setAttribute('data-row-edit-gate', '');
                row.setAttribute('data-editing', 'false');
                row.innerHTML =
                    '<span style="flex:1;font-size:13px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' +
                    (co.coNumber ? '<span style="font-size:10px;color:var(--text-dim);margin-right:4px;">' + escapeHTML(co.coNumber) + '</span>' : '') +
                    escapeHTML(co.description || 'CO') + '</span>' +
                    '<input type="text" inputmode="decimal" data-co-id="' + co.id + '" data-field="income" value="' + inc + '" title="Income (budget add)" style="width:100px;font-size:12px;padding:4px 6px;background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--green);text-align:right;" oninput="onCOBreakdownInput(this)">' +
                    '<input type="text" inputmode="decimal" data-co-id="' + co.id + '" data-field="estimatedCosts" value="' + cost + '" title="Estimated cost" style="width:100px;font-size:12px;padding:4px 6px;background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--yellow);text-align:right;" oninput="onCOBreakdownInput(this)">' +
                    '<button type="button" data-edit-gate-passthrough onclick="removeCOFromBreakdown(\'' + co.id + '\')" style="background:none;border:none;color:var(--red);cursor:pointer;font-size:14px;padding:2px 4px;" title="Delete CO">&times;</button>';
                rowsEl.appendChild(row);
            });
            if (window.p86EditGate) {
                window.p86EditGate.attachRowContainer(rowsEl, '[data-row-edit-gate]');
            }
            updateCOBreakdownTotals(buildingId);
        }

        function updateCOBreakdownTotals(buildingId) {
            const el = document.getElementById('bldgCOTotals');
            if (!el) return;
            const cos = cosForBuilding(buildingId);
            const inc = cos.reduce((s, c) => s + (c.income || 0), 0);
            const cost = cos.reduce((s, c) => s + (c.estimatedCosts || 0), 0);
            el.textContent = 'Income: ' + formatCurrency(inc) + ' · Cost: ' + formatCurrency(cost);
            el.style.color = 'var(--text-dim)';
        }

        function onCOBreakdownInput(input) {
            const coId = input.getAttribute('data-co-id');
            const field = input.getAttribute('data-field');
            const co = appData.changeOrders.find(c => c.id === coId);
            if (!co) return;
            const val = parseFloat(input.value) || 0;
            co[field] = val;
            updateCOBreakdownTotals(appState.editBuildingId);
        }

        // This used to push a flat {income, estimatedCosts} record into
        // appData.changeOrders — the dead localStorage relic that js/jobs.js
        // itself documents as legacy (see getJobCOTotals). Real change orders
        // live in job_change_orders and carry their money in line items, so
        // every CO created here saved "successfully", never appeared in the
        // Change Orders tab, and contributed nothing to the contract. It also
        // used native prompt(), which silently no-ops in the installed PWA.
        //
        // Rather than fabricate line items to fit the old flat shape, the
        // button now points at the surface that actually works. Allocating a
        // real CO's money across buildings is a genuine feature port and is
        // NOT implemented here — it needs the CO editor's line model.
        function addCOFromBuildingModal() {
            if (!appState.editBuildingId) return;
            const msg = 'Change orders are created in the Change Orders tab, where their line ' +
                        'items drive the price. This panel shows legacy building allocations only.';
            if (typeof window.p86Toast === 'function') window.p86Toast(msg);
            else if (typeof window.p86Confirm === 'function') window.p86Confirm({ title: 'Create a change order', message: msg, okText: 'OK' });
            else console.warn('[jobs] ' + msg);
        }

        function removeCOFromBreakdown(coId) {
            _confirmDelete('change order').then(function (ok) {
                if (!ok) return;
                appData.changeOrders = appData.changeOrders.filter(c => c.id !== coId);
                if (typeof saveData === 'function') saveData();
                renderBuildingCOBreakdown(appState.editBuildingId);
            });
        }

        // NOTE: gated on _confirmDelete, not native confirm(). Native dialogs
        // silently return undefined inside an installed PWA, so `if (!confirm())
        // return` made this a no-op there — the button appeared to do nothing.
        function deleteBuilding() {
            if (!appState.editBuildingId) return;
            const bldgId = appState.editBuildingId;
            const phases = appData.phases.filter(p => p.buildingId === bldgId);
            // Capture the name BEFORE the record goes — the graph cleanup needs it
            // to find nodes that carry no data link (see _deleteBuildingConfirmed).
            const bldgRec = appData.buildings.find(b => b.id === bldgId);
            const bldgName = bldgRec ? String(bldgRec.name || '').trim() : '';
            _confirmDelete('building', {
                message: phases.length
                    ? 'This building has ' + phases.length + ' scope record(s). Delete the building AND all of them?'
                    : 'Delete this building?'
            }).then(function (ok) { if (ok) _deleteBuildingConfirmed(bldgId, phases, bldgName); });
        }
        function _deleteBuildingConfirmed(bldgId, phases, bldgName) {
            if (phases.length) appData.phases = appData.phases.filter(p => p.buildingId !== bldgId);
            appData.buildings = appData.buildings.filter(b => b.id !== bldgId);
            appState.editBuildingId = null;
            saveData();
            // Mirror deletePhaseGroup's node-graph cleanup: strip the
            // building's t1 node, the deleted phases' t2 nodes, and every
            // wire touching them — otherwise ghost nodes (footprint, wires,
            // costs) survive on the map and keep feeding WIP totals.
            if (typeof NG !== 'undefined') {
                try {
                    const phaseIds = phases.map(p => p.id);
                    const ngNodes = NG.nodes();
                    const ngWires = NG.wires();
                    // Match the building node by data.id OR by name. A building
                    // TRACED on the satellite map is spawned label-only and has no
                    // `data` at all, so an id-only match never found it: the record
                    // was deleted, the footprint stayed on the map, and the orphan
                    // self-heal in nodegraph/ui.js then recreated the record from
                    // that surviving node — the building "came back instantly".
                    const wantName = String(bldgName || '').trim().toLowerCase();
                    const nodeName = n => String(n.label || '').split(' › ')[0].split(' > ')[0].trim().toLowerCase();
                    const nodeIdsToRemove = ngNodes.filter(n =>
                        (n.type === 't1' && (
                            (n.data && n.data.id === bldgId) ||
                            (!(n.data && n.data.id) && wantName && nodeName(n) === wantName)
                        )) ||
                        (n.type === 't2' && n.data && phaseIds.indexOf(n.data.id) !== -1)
                    ).map(n => n.id);
                    if (nodeIdsToRemove.length) {
                        NG.setNodes(ngNodes.filter(n => nodeIdsToRemove.indexOf(n.id) === -1));
                        NG.setWires(ngWires.filter(w => nodeIdsToRemove.indexOf(w.fromNode) === -1 && nodeIdsToRemove.indexOf(w.toNode) === -1));
                        NG.saveGraph();
                    }
                } catch(e) {}
            }
            closeModal('addBuildingModal');
            renderJobDetail(appState.currentJobId);
        }

        function autoBalancePhasePcts() {
            const jobId = appState.currentJobId;
            const buildingId = document.getElementById('phaseBuilding').value;
            if (!buildingId) { alert('Select a building first'); return; }
            const bldg = appData.buildings.find(b => b.id === buildingId);
            if (!bldg || !bldg.budget) { alert('Building has no budget set'); return; }
            const phases = appData.phases.filter(p => p.jobId === jobId && p.buildingId === buildingId);
            const lockedBudget = phases.filter(p => p.locked).reduce((sum, p) => sum + (p.phaseBudget || 0), 0);
            const unlocked = phases.filter(p => !p.locked);
            if (unlocked.length === 0) return;
            const remaining = Math.max(0, bldg.budget - lockedBudget);
            const each = remaining / unlocked.length;
            unlocked.forEach(p => {
                p.phaseBudget = Math.round(each * 100) / 100;
            });
            saveData();
            renderJobDetail(jobId);
        }

        function autoBalanceOnPhaseAdd(jobId, buildingId) {
            if (!buildingId) return;
            const bldg = appData.buildings.find(b => b.id === buildingId);
            if (!bldg || !bldg.budget) return;
            const phases = appData.phases.filter(p => p.jobId === jobId && p.buildingId === buildingId);
            const lockedBudget = phases.filter(p => p.locked).reduce((sum, p) => sum + (p.phaseBudget || 0), 0);
            const unlocked = phases.filter(p => !p.locked);
            if (unlocked.length === 0) return;
            const remaining = Math.max(0, bldg.budget - lockedBudget);
            const each = Math.round(remaining / unlocked.length * 100) / 100;
            unlocked.forEach(p => {
                p.phaseBudget = each;
            });
        }

        function autoBalanceBuildingPcts() {
            const jobId = appState.currentJobId;
            const buildings = appData.buildings.filter(b => b.jobId === jobId);
            const lockedPct = buildings.filter(b => b.locked).reduce((sum, b) => sum + (b.budgetPct || 0), 0);
            const unlocked = buildings.filter(b => !b.locked);
            if (unlocked.length === 0) return;
            const remaining = Math.max(0, 100 - lockedPct);
            const each = remaining / unlocked.length;
            const contractAmt = appData.jobs.find(j => j.id === jobId)?.contractAmount || 0;
            unlocked.forEach(b => {
                b.budgetPct = Math.round(each * 10) / 10;
                b.budget = contractAmt > 0 ? Math.round(contractAmt * b.budgetPct / 100 * 100) / 100 : b.budget;
            });
            saveData();
            renderJobDetail(jobId);
        }

        function autoBalanceOnBuildingAdd(jobId) {
            const buildings = appData.buildings.filter(b => b.jobId === jobId);
            const lockedPct = buildings.filter(b => b.locked).reduce((sum, b) => sum + (b.budgetPct || 0), 0);
            const unlocked = buildings.filter(b => !b.locked);
            if (unlocked.length === 0) return;
            const remaining = Math.max(0, 100 - lockedPct);
            const each = Math.round(remaining / unlocked.length * 10) / 10;
            const contractAmt = appData.jobs.find(j => j.id === jobId)?.contractAmount || 0;
            unlocked.forEach(b => {
                b.budgetPct = each;
                b.budget = contractAmt > 0 ? Math.round(contractAmt * each / 100 * 100) / 100 : b.budget;
            });
        }

        // Rename the building's site-plan node so the graph->appData sync (which
        // copies node.label onto building.name on every run) carries the new name
        // instead of reverting to the old one. Traced nodes have no data link, so
        // fall back to matching on the previous name.
        function _renameBuildingNode(bldgId, priorName, newName) {
            if (!newName || newName === priorName) return;
            if (typeof NG === 'undefined' || !NG.nodes) return;
            try {
                var want = String(priorName || '').trim().toLowerCase();
                var base = function (n) { return String(n.label || '').split(' › ')[0].split(' > ')[0].trim(); };
                var node = NG.nodes().find(function (n) {
                    if (n.type !== 't1') return false;
                    if (n.data && n.data.id) return n.data.id === bldgId;
                    return want && base(n).toLowerCase() === want;
                });
                if (!node) return;
                // Preserve any " › suffix" the label carries after the base name.
                var rest = String(node.label || '').slice(base(node).length);
                node.label = newName + rest;
                if (NG.saveGraph) NG.saveGraph();
            } catch (e) {}
        }
        function saveBuilding() {
            const hoursWeek = parseFloat(document.getElementById('buildingHoursWeek').value) || 0;
            const hoursTotal = (parseFloat(document.getElementById('buildingHoursTotal').value) || 0) + hoursWeek;
            const rate = parseFloat(document.getElementById('buildingRate').value) || 40;
            const asSoldVal = parseFloat(document.getElementById('buildingBudget').value) || 0;
            const existingCO = appState.editBuildingId
                ? (appData.buildings.find(b => b.id === appState.editBuildingId)?.coBudget || 0) : 0;
            const formData = {
                name: document.getElementById('buildingName').value,
                asSoldBudget: asSoldVal,
                coBudget: existingCO,
                budget: asSoldVal + existingCO,
                address: document.getElementById('buildingAddress').value,
                workScope: document.getElementById('buildingWorkScope').value || 'in-house',
                locked: document.getElementById('buildingLocked').checked,
                excludeFromSubDist: document.getElementById('buildingExcludeSubDist').checked,
                materials: parseFloat(document.getElementById('buildingMaterials').value) || 0,
                labor: hoursTotal * rate,
                sub: 0, // auto-calculated from Subs tab by recalcSubCosts
                equipment: parseFloat(document.getElementById('buildingEquipment').value) || 0,
                hoursWeek: hoursWeek,
                hoursTotal: hoursTotal,
                rate: rate
            };

            if (appState.editBuildingId) {
                const idx = appData.buildings.findIndex(b => b.id === appState.editBuildingId);
                if (idx !== -1) {
                    const priorName = String(appData.buildings[idx].name || '').trim();
                    Object.assign(appData.buildings[idx], formData);
                    // Carry the rename onto the graph node. The site-plan sync
                    // copies node.label -> building.name on EVERY run, so without
                    // this the node's old label overwrites the new name on the next
                    // sync and the rename silently reverts. Matched by data.id, or
                    // by the OLD name for traced nodes, which carry no data link.
                    _renameBuildingNode(appState.editBuildingId, priorName, String(formData.name || '').trim());
                }
                appState.editBuildingId = null;
            } else {
                const building = Object.assign({
                    id: 'b' + Date.now(),
                    jobId: appState.currentJobId
                }, formData);
                appData.buildings.push(building);
            }
            saveData();
            closeModal('addBuildingModal');
            renderJobDetail(appState.currentJobId);
        }

        function getSelectedBuildingBudget() {
            const buildingId = document.getElementById('phaseBuilding').value;
            const building = appData.buildings.find(b => b.id === buildingId);
            return building ? (building.budget || 0) : 0;
        }

        // Phase budget % helpers — dead since the phase modal lost its
        // budget + %-of-building inputs. Kept as safe no-ops because
        // legacy onchange/oninput attributes may still reference them
        // until older deployed pages flush from cache.
        function syncBudgetFromPct() { /* no-op */ }
        function syncBudgetFromDollar() { /* no-op */ }

        function openAddPhaseToJobModal(preselectedBuildingId) {
            appState.editPhaseId = null;
            document.getElementById('phaseModalHeader').textContent = 'Add Scope';
            document.getElementById('savePhaseBtn').innerHTML = '&#x1F4CB; Add Scope';
            document.getElementById('deletePhaseBtn').style.display = 'none';

            const buildings = appData.buildings.filter(b => b.jobId === appState.currentJobId);
            const select = document.getElementById('phaseBuilding');
            select.innerHTML = '<option value="">-- Select Building --</option>';
            buildings.forEach(b => {
                const opt = document.createElement('option');
                opt.value = b.id;
                opt.textContent = b.name;
                if (preselectedBuildingId && b.id === preselectedBuildingId) opt.selected = true;
                select.appendChild(opt);
            });

            populatePhaseTypeSelect();
            document.getElementById('phaseType').value = '';
            document.getElementById('phaseAsSoldRevenue').value = '';
            document.getElementById('phasePercent').value = '0';
            document.getElementById('phaseNotes').value = '';
            document.getElementById('phaseWorkScope').value = 'in-house';
            document.getElementById('phaseBuildingWrap').style.display = '';
            document.getElementById('phaseConnectedWrap').style.display = 'none';
            openModal('addPhaseModal');
        }

        function editPhase(phaseId) {
            const phase = appData.phases.find(p => p.id === phaseId);
            if (!phase) return;

            appState.editPhaseId = phaseId;
            document.getElementById('phaseModalHeader').textContent = 'Edit Scope';
            document.getElementById('savePhaseBtn').innerHTML = '&#x1F4BE; Save Changes';
            document.getElementById('deletePhaseBtn').style.display = 'inline-block';

            const buildings = appData.buildings.filter(b => b.jobId === phase.jobId);
            const select = document.getElementById('phaseBuilding');
            select.innerHTML = '<option value="">-- Select Building --</option>';
            buildings.forEach(b => {
                const opt = document.createElement('option');
                opt.value = b.id;
                opt.textContent = b.name;
                select.appendChild(opt);
            });
            select.value = phase.buildingId || '';

            // Determine graph wire connections. If the phase has multiple wired
            // buildings, show the connection list and hide the single-building
            // selector — connections are managed in the node graph.
            let wiredBldgs = [];
            if (typeof NG !== 'undefined') {
                try {
                    const ngNodes = NG.nodes();
                    const ngWires = NG.wires();
                    const t2 = ngNodes.find(n => n.type === 't2' && n.data && n.data.id === phase.id);
                    if (t2) {
                        ngWires.forEach(w => {
                            if (w.fromNode === t2.id) {
                                const t1 = ngNodes.find(n => n.id === w.toNode && n.type === 't1');
                                if (t1 && t1.data) {
                                    wiredBldgs.push({ name: (t1.data.name || 'Building'), pct: w.allocPct != null ? w.allocPct : 0 });
                                }
                            }
                        });
                    }
                } catch(e) {}
            }
            const hasMulti = wiredBldgs.length > 1;
            document.getElementById('phaseBuildingWrap').style.display = hasMulti ? 'none' : '';
            const connWrap = document.getElementById('phaseConnectedWrap');
            if (wiredBldgs.length > 0) {
                connWrap.style.display = '';
                const totalPct = wiredBldgs.reduce((s, b) => s + b.pct, 0);
                const pctOk = Math.abs(totalPct - 100) < 0.1 || totalPct === 0;
                document.getElementById('phaseConnectedList').innerHTML =
                    wiredBldgs.map(b =>
                        '<div style="display:flex;justify-content:space-between;padding:3px 0;">' +
                        '<span>' + escapeHTML(b.name) + '</span>' +
                        '<span style="color:var(--yellow);font-family:\'Courier New\',monospace;">' + b.pct.toFixed(1) + '%</span>' +
                        '</div>'
                    ).join('') +
                    '<div style="display:flex;justify-content:space-between;padding:4px 0 0;border-top:1px solid var(--border);margin-top:4px;font-weight:600;">' +
                        '<span>Total</span>' +
                        '<span style="color:' + (pctOk ? 'var(--green)' : 'var(--red)') + ';font-family:\'Courier New\',monospace;">' + totalPct.toFixed(1) + '% ' + (pctOk ? '\u2713' : '\u26A0') + '</span>' +
                    '</div>';
            } else {
                connWrap.style.display = 'none';
            }

            populatePhaseTypeSelect();
            if (phase.phase && !Array.from(document.getElementById('phaseType').options).some(o => o.value === phase.phase)) {
                const c = getCustomItems('p86-jobs-custom-phases');
                if (!c.includes(phase.phase)) { c.push(phase.phase); saveCustomItems('p86-jobs-custom-phases', c); populatePhaseTypeSelect(); }
            }
            document.getElementById('phaseType').value = phase.phase || '';
            // As-Sold Revenue is the only dollar field on the phase
            // entry now. Fall back to phaseBudget for legacy rows
            // that were saved before the rename so existing phases
            // don't read as $0 on first re-edit.
            document.getElementById('phaseAsSoldRevenue').value =
                phase.asSoldRevenue || phase.asSoldPhaseBudget || phase.phaseBudget || '';
            document.getElementById('phasePercent').value = phase.pctComplete || 0;
            document.getElementById('phaseNotes').value = phase.notes || '';
            document.getElementById('phaseWorkScope').value = phase.workScope || 'in-house';
            openModal('addPhaseModal');
        }

        function deletePhase() {
            if (!appState.editPhaseId) return;
            _confirmDelete('scope entry', { message: 'Delete this scope entry? This cannot be undone.' })
                .then(function (ok) { if (ok) _deletePhaseConfirmed(); });
        }
        function _deletePhaseConfirmed() {
            const phaseId = appState.editPhaseId;
            if (!phaseId) return;
            appData.phases = appData.phases.filter(p => p.id !== phaseId);
            appState.editPhaseId = null;
            saveData();
            // Mirror deletePhaseGroup's node-graph cleanup: strip the phase's
            // t2 node + its wires so no ghost chip stays on the map feeding
            // WIP totals.
            if (typeof NG !== 'undefined') {
                try {
                    const ngNodes = NG.nodes();
                    const ngWires = NG.wires();
                    const nodeIdsToRemove = ngNodes.filter(n => n.type === 't2' && n.data && n.data.id === phaseId).map(n => n.id);
                    if (nodeIdsToRemove.length) {
                        NG.setNodes(ngNodes.filter(n => nodeIdsToRemove.indexOf(n.id) === -1));
                        NG.setWires(ngWires.filter(w => nodeIdsToRemove.indexOf(w.fromNode) === -1 && nodeIdsToRemove.indexOf(w.toNode) === -1));
                        NG.saveGraph();
                    }
                } catch(e) {}
            }
            closeModal('addPhaseModal');
            renderJobDetail(appState.currentJobId);
        }

        // ── Manage Phases Modal ──
        function openManagePhasesModal() {
            renderManagePhasesList();
            document.getElementById('managePhasesModal').classList.add('active');
        }

        function renderManagePhasesList() {
            const jobId = appState.currentJobId;
            const list = document.getElementById('managePhasesList');
            const phases = (appData.phases || []).filter(p => p.jobId === jobId);
            if (!phases.length) {
                list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-dim);">No phases for this job yet.</div>';
                return;
            }
            // Group by phase name (case-insensitive)
            const groups = {};
            phases.forEach(p => {
                const key = (p.phase || 'Unnamed').trim().toLowerCase();
                if (!groups[key]) groups[key] = { name: p.phase || 'Unnamed', records: [] };
                groups[key].records.push(p);
            });
            let html = '';
            Object.keys(groups).sort().forEach(key => {
                const g = groups[key];
                const count = g.records.length;
                const totalRev = g.records.reduce((s, r) => s + phaseRevenue(r), 0);
                const isDup = count > 1;
                const bldgNames = g.records.map(r => {
                    const b = appData.buildings.find(bb => bb.id === r.buildingId);
                    return b ? b.name : '(no building)';
                });
                html += '<div style="border:1px solid var(--border);border-radius:6px;padding:10px 12px;margin-bottom:8px;background:var(--surface);">';
                html += '<div style="display:flex;gap:10px;align-items:center;">';
                html += '<input type="text" data-mp-name="' + key + '" value="' + escapeHTML(g.name) + '" style="flex:1;padding:6px 8px;background:var(--input-bg,#101014);color:var(--text);border:1px solid var(--border);border-radius:4px;font-size:13px;font-weight:600;" />';
                html += '<div style="font-size:11px;color:var(--text-dim);white-space:nowrap;">' + count + ' record' + (count > 1 ? 's' : '') + '</div>';
                html += '<input type="text" inputmode="decimal" data-mp-rev="' + key + '" value="' + totalRev.toFixed(2) + '" style="width:120px;padding:6px 8px;background:var(--input-bg,#101014);color:var(--text);border:1px solid var(--border);border-radius:4px;font-size:13px;text-align:right;" title="Total revenue" />';
                if (isDup) {
                    html += '<button class="btn btn-primary small" style="padding:5px 10px;font-size:11px;" onclick="mergePhaseGroup(\'' + key + '\')">Merge</button>';
                } else {
                    html += '<button class="btn btn-secondary small" style="padding:5px 10px;font-size:11px;" onclick="saveManagedPhase(\'' + key + '\')">Save</button>';
                }
                html += '<button class="btn danger small" style="padding:5px 10px;font-size:11px;" onclick="deletePhaseGroup(\'' + key + '\')">&#x1F5D1;</button>';
                html += '</div>';
                if (isDup) {
                    html += '<div style="font-size:10px;color:var(--text-dim);margin-top:6px;padding-top:6px;border-top:1px dashed var(--border);">';
                    html += '<span style="color:var(--yellow);">&#9888; Duplicate</span> &mdash; Buildings: ' + escapeHTML(bldgNames.join(', '));
                    html += '<br>Merging creates 1 record and auto-wires to all ' + count + ' buildings at ' + (100/count).toFixed(1) + '% allocation each.';
                    html += '</div>';
                }
                html += '</div>';
            });
            list.innerHTML = html;
        }

        function mergePhaseGroup(key) {
            const jobId = appState.currentJobId;
            const phases = (appData.phases || []).filter(p => p.jobId === jobId && (p.phase || 'Unnamed').trim().toLowerCase() === key);
            if (phases.length < 2) return;
            const nameInput = document.querySelector('[data-mp-name="' + key + '"]');
            const revInput = document.querySelector('[data-mp-rev="' + key + '"]');
            const newName = nameInput ? nameInput.value.trim() : phases[0].phase;
            const newRev = revInput ? (parseFloat(revInput.value) || 0) : phases.reduce((s, r) => s + phaseRevenue(r), 0);
            // Keep the first record, absorb the rest
            const keeper = phases[0];
            const absorbed = phases.slice(1);
            keeper.phase = newName;
            keeper.asSoldRevenue = newRev;
            keeper.materials = phases.reduce((s, r) => s + (r.materials || 0), 0);
            keeper.labor = phases.reduce((s, r) => s + (r.labor || 0), 0);
            keeper.sub = phases.reduce((s, r) => s + (r.sub || 0), 0);
            keeper.equipment = phases.reduce((s, r) => s + (r.equipment || 0), 0);
            keeper.buildingId = ''; // phase now spans buildings via graph wires
            // Collect all building IDs from the absorbed records to auto-wire later
            const bldgIds = phases.map(p => p.buildingId).filter(Boolean);
            // Redirect any subs/POs referencing absorbed phase IDs to the keeper
            const absorbedIds = absorbed.map(a => a.id);
            (appData.subs || []).forEach(s => {
                if (s.phaseId && absorbedIds.indexOf(s.phaseId) !== -1) s.phaseId = keeper.id;
                if (s.phaseIds) s.phaseIds = s.phaseIds.map(pid => absorbedIds.indexOf(pid) !== -1 ? keeper.id : pid);
            });
            // Remove absorbed phases
            appData.phases = appData.phases.filter(p => absorbedIds.indexOf(p.id) === -1);
            saveData();
            // Rewire graph if it exists
            mergeUpdateGraph(keeper.id, absorbedIds, bldgIds);
            renderManagePhasesList();
            renderJobDetail(jobId);
        }

        function saveManagedPhase(key) {
            const jobId = appState.currentJobId;
            const phase = (appData.phases || []).find(p => p.jobId === jobId && (p.phase || 'Unnamed').trim().toLowerCase() === key);
            if (!phase) return;
            const nameInput = document.querySelector('[data-mp-name="' + key + '"]');
            const revInput = document.querySelector('[data-mp-rev="' + key + '"]');
            if (nameInput) phase.phase = nameInput.value.trim();
            if (revInput) phase.asSoldRevenue = parseFloat(revInput.value) || 0;
            saveData();
            // Sync revenue to node graph if present
            if (typeof NG !== 'undefined') {
                try {
                    const ngNodes = NG.nodes();
                    ngNodes.forEach(n => {
                        if (n.type === 't2' && n.data && n.data.id === phase.id) {
                            n.revenue = phase.asSoldRevenue;
                            n.label = phase.phase;
                        }
                    });
                    NG.saveGraph();
                } catch(e) {}
            }
            renderManagePhasesList();
            renderJobDetail(jobId);
        }

        function deletePhaseGroup(key) {
            const jobId = appState.currentJobId;
            const phases = (appData.phases || []).filter(p => p.jobId === jobId && (p.phase || 'Unnamed').trim().toLowerCase() === key);
            if (!phases.length) return;
            _confirmDelete('scope', {
                message: 'Delete this scope and its ' + phases.length + ' allocation record(s)? This cannot be undone.'
            }).then(function (ok) { if (ok) _deletePhaseGroupConfirmed(jobId, phases); });
        }
        function _deletePhaseGroupConfirmed(jobId, phases) {
            const ids = phases.map(p => p.id);
            appData.phases = appData.phases.filter(p => ids.indexOf(p.id) === -1);
            saveData();
            // Remove corresponding nodes from graph
            if (typeof NG !== 'undefined') {
                try {
                    const ngNodes = NG.nodes();
                    const ngWires = NG.wires();
                    const nodeIdsToRemove = ngNodes.filter(n => n.type === 't2' && n.data && ids.indexOf(n.data.id) !== -1).map(n => n.id);
                    NG.setNodes(ngNodes.filter(n => nodeIdsToRemove.indexOf(n.id) === -1));
                    NG.setWires(ngWires.filter(w => nodeIdsToRemove.indexOf(w.fromNode) === -1 && nodeIdsToRemove.indexOf(w.toNode) === -1));
                    NG.saveGraph();
                } catch(e) {}
            }
            renderManagePhasesList();
            renderJobDetail(jobId);
        }

        // After merging phase records in appData, consolidate matching graph nodes
        // and auto-create allocation wires to the original buildings.
        function mergeUpdateGraph(keeperId, absorbedIds, bldgIds) {
            if (typeof NG === 'undefined') return;
            try {
                const ngNodes = NG.nodes();
                const ngWires = NG.wires();
                // Find all T2 nodes that were for any of the phase records
                const allIds = [keeperId].concat(absorbedIds);
                const t2Nodes = ngNodes.filter(n => n.type === 't2' && n.data && allIds.indexOf(n.data.id) !== -1);
                if (!t2Nodes.length) return;
                // Keep the first T2 node, redirect wires from others, then delete others
                const keeperNode = t2Nodes[0];
                keeperNode.data.id = keeperId;
                // Pull revenue from the keeper phase record
                const keeperPhase = appData.phases.find(p => p.id === keeperId);
                if (keeperPhase) {
                    keeperNode.revenue = keeperPhase.asSoldRevenue || 0;
                    keeperNode.label = keeperPhase.phase || keeperNode.label;
                }
                const removeIds = t2Nodes.slice(1).map(n => n.id);
                // Redirect any wires pointing to/from absorbed t2 nodes to the keeper
                ngWires.forEach(w => {
                    if (removeIds.indexOf(w.fromNode) !== -1) w.fromNode = keeperNode.id;
                    if (removeIds.indexOf(w.toNode) !== -1) w.toNode = keeperNode.id;
                });
                // Dedupe wires
                const seen = {};
                const deduped = [];
                ngWires.forEach(w => {
                    const k = w.fromNode + '|' + w.fromPort + '|' + w.toNode + '|' + w.toPort;
                    if (!seen[k]) { seen[k] = true; deduped.push(w); }
                });
                NG.setWires(deduped);
                NG.setNodes(ngNodes.filter(n => removeIds.indexOf(n.id) === -1));
                // Ensure the keeper is wired to each original building (T1 node)
                const finalWires = NG.wires();
                (bldgIds || []).forEach(bid => {
                    const t1 = NG.nodes().find(n => n.type === 't1' && n.data && n.data.id === bid);
                    if (!t1) return;
                    const exists = finalWires.some(w => w.fromNode === keeperNode.id && w.toNode === t1.id);
                    if (!exists) finalWires.push({ fromNode: keeperNode.id, fromPort: 0, toNode: t1.id, toPort: 0 });
                });
                NG.rebalancePhaseAllocations(keeperNode.id);
                NG.saveGraph();
            } catch(e) { console.error('mergeUpdateGraph failed', e); }
        }

        function savePhase() {
            // Phase entry was decluttered: only Building, Phase,
            // As-Sold Revenue, % Complete, Work Scope, and Notes are
            // user inputs. Cost-side fields (materials/labor/sub/
            // equipment) and labor-hour fields are now driven by the
            // node graph and the Subs tab; we don't surface them here
            // anymore. asSoldPhaseBudget + phaseBudget mirror revenue
            // so the existing WIP rollup math (which still reads
            // phaseBudget) keeps working unchanged.
            const asSoldRevenue = parseFloat(document.getElementById('phaseAsSoldRevenue').value) || 0;
            const existingCO = appState.editPhaseId
                ? (appData.phases.find(p => p.id === appState.editPhaseId)?.coPhaseBudget || 0) : 0;

            // Validate phase revenue doesn't exceed the parent
            // building's budget across all its phases.
            const selectedBuildingId = document.getElementById('phaseBuilding').value;
            if (selectedBuildingId) {
                const bldg = appData.buildings.find(b => b.id === selectedBuildingId);
                if (bldg && bldg.budget > 0) {
                    const bldgPhases = appData.phases.filter(p => p.jobId === appState.currentJobId && p.buildingId === selectedBuildingId);
                    let existingBudgetTotal = bldgPhases.reduce((sum, p) => sum + (p.phaseBudget || 0), 0);
                    if (appState.editPhaseId) {
                        const editP = bldgPhases.find(p => p.id === appState.editPhaseId);
                        if (editP) existingBudgetTotal -= (editP.phaseBudget || 0);
                    }
                    if (existingBudgetTotal + asSoldRevenue > bldg.budget * 1.001) {
                        const remaining = bldg.budget - existingBudgetTotal;
                        alert('Phase revenue cannot exceed building budget (' + formatCurrency(bldg.budget) + '). Currently ' + formatCurrency(existingBudgetTotal) + ' allocated. Remaining: ' + formatCurrency(remaining));
                        return;
                    }
                }
            }

            // If phase is wired to multiple buildings in the graph, keep buildingId empty.
            const isMultiWired = document.getElementById('phaseConnectedWrap').style.display !== 'none'
                && document.getElementById('phaseBuildingWrap').style.display === 'none';
            const formData = {
                buildingId: isMultiWired ? '' : document.getElementById('phaseBuilding').value,
                phase: document.getElementById('phaseType').value,
                workScope: document.getElementById('phaseWorkScope').value || 'in-house',
                pctComplete: parseFloat(document.getElementById('phasePercent').value) || 0,
                asSoldRevenue: asSoldRevenue,
                asSoldPhaseBudget: asSoldRevenue,
                coPhaseBudget: existingCO,
                phaseBudget: asSoldRevenue + existingCO,
                notes: document.getElementById('phaseNotes').value
            };

            if (appState.editPhaseId) {
                const idx = appData.phases.findIndex(p => p.id === appState.editPhaseId);
                if (idx !== -1) {
                    Object.assign(appData.phases[idx], formData);
                    // Sync revenue + name to graph T2 node if present
                    if (typeof NG !== 'undefined') {
                        try {
                            const ngNodes = NG.nodes();
                            ngNodes.forEach(n => {
                                if (n.type === 't2' && n.data && n.data.id === appState.editPhaseId) {
                                    n.revenue = asSoldRevenue;
                                    n.pctComplete = formData.pctComplete;
                                    // Preserve the " › Building" / " +N" suffix by keeping whatever label updateTierLabels derived
                                }
                            });
                            NG.saveGraph();
                        } catch(e) {}
                    }
                }
                appState.editPhaseId = null;
            } else {
                const phase = Object.assign({
                    id: 'p' + Date.now(),
                    jobId: appState.currentJobId,
                    dateAdded: new Date().toISOString()
                }, formData);
                appData.phases.push(phase);
                autoBalanceOnPhaseAdd(appState.currentJobId, phase.buildingId);
            }
            saveData();
            closeModal('addPhaseModal');
            renderJobDetail(appState.currentJobId);
        }

        function openAddSubToJobModal() {
            appState.editSubId = null;
            document.getElementById('subModalHeader').textContent = 'Add Subcontractor';
            document.getElementById('subSaveBtn').innerHTML = '&#x1F477; Add Subcontractor';
            document.getElementById('subName').value = '';
            populateSubTradeSelect();
            document.getElementById('subTrade').value = '';
            document.getElementById('subContract').value = '';
            document.getElementById('subBilled').value = '';
            document.getElementById('subNotes').value = '';
            populateSubDirectoryList();
            updateSubDirectoryHint();
            openModal('addSubModal');
        }

        // Phase C: feed the datalist from appData.subsDirectory so the
        // user gets typeahead-style autocomplete over existing subs.
        // Picking a directory match also auto-fills the trade and
        // surfaces a hint that links to the directory record.
        function populateSubDirectoryList() {
            const dl = document.getElementById('subDirectoryList');
            if (!dl) return;
            const dir = (window.appData && appData.subsDirectory) || [];
            dl.innerHTML = dir
                .filter(s => s.status !== 'closed')
                .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
                .map(s => '<option value="' + escapeHTML(s.name) + '">' +
                    escapeHTML(s.trade || '') + (s.contact_name ? ' · ' + escapeHTML(s.contact_name) : '') +
                '</option>')
                .join('');
        }

        function updateSubDirectoryHint() {
            const nameEl = document.getElementById('subName');
            const tradeEl = document.getElementById('subTrade');
            const hintEl = document.getElementById('subDirectoryHint');
            if (!nameEl || !hintEl) return;
            const typed = nameEl.value.trim();
            if (!typed) {
                hintEl.innerHTML = (appData.subsDirectory && appData.subsDirectory.length)
                    ? '<span style="color:var(--text-dim,#888);">Pick from ' + appData.subsDirectory.length + ' directory entries — or type a new name to create one.</span>'
                    : '';
                return;
            }
            const dir = (appData.subsDirectory || []);
            const match = dir.find(s => (s.name || '').toLowerCase() === typed.toLowerCase());
            if (match) {
                hintEl.innerHTML = '<span style="color:#34d399;">&#x2713; Linked to directory: <strong>' + escapeHTML(match.name) + '</strong>' +
                    (match.trade ? ' (' + escapeHTML(match.trade) + ')' : '') + '</span>';
                // Auto-fill trade from directory if user hasn't set one
                if (tradeEl && !tradeEl.value && match.trade) {
                    // Only set if the option exists; otherwise add it
                    const exists = [...tradeEl.options].some(o => o.value === match.trade);
                    if (!exists) {
                        const opt = document.createElement('option');
                        opt.value = match.trade; opt.textContent = match.trade;
                        tradeEl.appendChild(opt);
                    }
                    tradeEl.value = match.trade;
                }
            } else {
                hintEl.innerHTML = '<span style="color:#fbbf24;">New sub — will create a directory record on save.</span>';
            }
        }
        // Wire the input change so the hint stays current as the user types/picks
        document.addEventListener('DOMContentLoaded', function() {
            const el = document.getElementById('subName');
            if (el) el.addEventListener('input', updateSubDirectoryHint);
        });

        function saveSub() {
            const subData = {
                jobId: appState.currentJobId,
                name: document.getElementById('subName').value,
                trade: document.getElementById('subTrade').value,
                level: 'job',
                contractAmt: parseFloat(document.getElementById('subContract').value) || 0,
                billedToDate: parseFloat(document.getElementById('subBilled').value) || 0,
                notes: document.getElementById('subNotes').value
            };

            if (appState.editSubId) {
                const idx = appData.subs.findIndex(s => s.id === appState.editSubId);
                if (idx >= 0) {
                    subData.id = appState.editSubId;
                    appData.subs[idx] = subData;
                }
            } else {
                subData.id = 's' + Date.now();
                appData.subs.push(subData);
            }
            saveData();
            closeModal('addSubModal');
            renderJobDetail(appState.currentJobId);
        }

        function editSub(subId) {
            const sub = appData.subs.find(s => s.id === subId);
            if (!sub) return;
            appState.editSubId = subId;
            document.getElementById('subModalHeader').textContent = 'Edit Subcontractor';
            document.getElementById('subSaveBtn').innerHTML = '&#x1F4BE; Save Changes';
            populateSubDirectoryList();
            document.getElementById('subName').value = sub.name || '';
            updateSubDirectoryHint();
            populateSubTradeSelect();
            if (sub.trade && !Array.from(document.getElementById('subTrade').options).some(o => o.value === sub.trade)) {
                const c = getCustomItems('p86-jobs-custom-trades');
                if (!c.includes(sub.trade)) { c.push(sub.trade); saveCustomItems('p86-jobs-custom-trades', c); populateSubTradeSelect(); }
            }
            document.getElementById('subTrade').value = sub.trade || '';
            document.getElementById('subContract').value = sub.contractAmt || '';
            document.getElementById('subBilled').value = sub.billedToDate || '';
            document.getElementById('subNotes').value = sub.notes || '';
            openModal('addSubModal');
        }

        function deleteSub(subId) {
            _confirmDelete('subcontractor').then(function (ok) {
                if (!ok) return;
                appData.subs = appData.subs.filter(s => s.id !== subId);
                saveData();
                renderJobDetail(appState.currentJobId);
            });
        }

        function showArchivedJobs() {
            var mainView = document.getElementById('jobs-main-view');
            var archiveView = document.getElementById('archived-jobs-list');
            if (!mainView || !archiveView) return;
            var showing = archiveView.style.display !== 'none';
            if (showing) {
                archiveView.style.display = 'none';
                mainView.style.display = '';
                document.querySelectorAll('.jobs-action-tab').forEach(function(t) { t.classList.remove('active'); });
            } else {
                mainView.style.display = 'none';
                archiveView.style.display = '';
                document.querySelectorAll('.jobs-action-tab').forEach(function(t) {
                    t.classList.toggle('active', t.textContent.trim() === 'Archived');
                });
                renderArchivedJobs();
            }
        }

        // ==================== ARCHIVED JOBS ====================
        function renderArchivedJobs() {
            var container = document.getElementById('archived-jobs-list');
            if (!container) return;
            container.innerHTML = '';

            var archived = appData.jobs.filter(function(j) { return j.status === 'Archived'; });

            var html = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">' +
                '<h2 style="font-size:18px;margin:0;">Archived Jobs (' + archived.length + ')</h2>' +
                '<button class="jobs-action-tab" onclick="showArchivedJobs()" style="font-size:12px;">&larr; Back to Jobs</button></div>';

            if (archived.length === 0) {
                html += '<div class="card" style="padding:30px;text-align:center;color:var(--text-dim);">No archived jobs. Archive a job by setting its status to "Archived" in the job editor.</div>';
                container.innerHTML = html;
                return;
            }

            archived.forEach(function(job) {
                var w = getJobWIP(job.id);
                var profit = (w.revenueEarned || 0) - (w.actualCosts || 0);
                var margin = w.revenueEarned > 0 ? (profit / w.revenueEarned * 100) : 0;
                var snapCount = (job.weeklySnapshots || []).length;
                var marginColor = margin >= 15 ? 'var(--green)' : margin >= 0 ? 'var(--yellow)' : 'var(--red)';

                html += '<div class="card" style="padding:12px 14px;margin-bottom:8px;">';
                html += '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;">';

                // Left: job info
                html += '<div style="flex:1;min-width:0;">';
                html += '<div style="font-size:14px;font-weight:600;margin-bottom:2px;">' + escapeHTML((job.jobNumber ? job.jobNumber + ' — ' : '') + (job.title || 'Untitled')) + '</div>';
                html += '<div style="font-size:11px;color:var(--text-dim);margin-bottom:6px;">' +
                    (job.client ? escapeHTML(job.client) + ' &middot; ' : '') +
                    (job.pm ? 'PM: ' + escapeHTML(job.pm) + ' &middot; ' : '') +
                    snapCount + ' weekly snapshots</div>';

                // KPIs row
                html += '<div style="display:flex;gap:14px;font-size:11px;flex-wrap:wrap;">';
                html += '<div><span style="color:var(--text-dim);">Income</span> <b>' + formatCurrency(w.totalIncome) + '</b></div>';
                html += '<div><span style="color:var(--text-dim);">Rev Earned</span> <b style="color:var(--green);">' + formatCurrency(w.revenueEarned) + '</b></div>';
                html += '<div><span style="color:var(--text-dim);">Costs</span> <b style="color:var(--red);">' + formatCurrency(w.actualCosts) + '</b></div>';
                html += '<div><span style="color:var(--text-dim);">Profit</span> <b style="color:' + (profit >= 0 ? 'var(--green)' : 'var(--red)') + ';">' + formatCurrency(profit) + '</b></div>';
                html += '<div><span style="color:var(--text-dim);">Margin</span> <b style="color:' + marginColor + ';">' + margin.toFixed(1) + '%</b></div>';
                html += '<div><span style="color:var(--text-dim);">Complete</span> <b>' + (w.pctComplete || 0).toFixed(1) + '%</b></div>';
                html += '</div>';
                html += '</div>';

                // Right: action buttons
                html += '<div style="display:flex;flex-direction:column;gap:4px;flex-shrink:0;">';
                html += '<button onclick="editJob(\'' + escapeHTML(job.id) + '\')" class="ee-btn secondary">Edit</button>';
                html += '<button onclick="restoreJob(\'' + escapeHTML(job.id) + '\')" class="ee-btn success">Restore</button>';
                html += '<button onclick="deleteArchivedJob(\'' + escapeHTML(job.id) + '\')" class="ee-btn danger">Delete</button>';
                html += '</div>';

                html += '</div></div>';
            });

            container.innerHTML = html;
        }

        function restoreJob(jobId) {
            var job = appData.jobs.find(function(j) { return j.id === jobId; });
            if (!job) return;
            job.status = 'In Progress';
            saveData();
            renderArchivedJobs();
        }

        function deleteArchivedJob(jobId) {
            _confirmDelete('job', { message: 'Permanently delete this job and all its data? This cannot be undone.' })
                .then(function (ok) { if (ok) _deleteArchivedJobConfirmed(jobId); });
        }
        function _deleteArchivedJobConfirmed(jobId) {
            appData.jobs = appData.jobs.filter(function(j) { return j.id !== jobId; });
            appData.buildings = appData.buildings.filter(function(b) { return b.jobId !== jobId; });
            appData.phases = appData.phases.filter(function(p) { return p.jobId !== jobId; });
            appData.changeOrders = appData.changeOrders.filter(function(c) { return c.jobId !== jobId; });
            appData.subs = appData.subs.filter(function(s) { return s.jobId !== jobId; });
            appData.purchaseOrders = (appData.purchaseOrders || []).filter(function(p) { return p.jobId !== jobId; });
            appData.invoices = (appData.invoices || []).filter(function(i) { return i.jobId !== jobId; });
            // Remove node graph
            try {
                var all = JSON.parse(localStorage.getItem('p86-nodegraphs') || '{}');
                delete all[jobId];
                localStorage.setItem('p86-nodegraphs', JSON.stringify(all));
            } catch (e) {}
            saveData();
            // Server-side delete (bulk-save only upserts; without this the
            // job comes back on next page reload).
            if (window.p86Api && window.p86Api.isAuthenticated()) {
                window.p86Api.jobs.remove(jobId).catch(function(err) {
                    console.warn('Server delete failed for ' + jobId + ':', err.message);
                });
            }
            renderArchivedJobs();
        }


        // ==================== ESTIMATES FUNCTIONS (FROM ORIGINAL FILE) ====================
        