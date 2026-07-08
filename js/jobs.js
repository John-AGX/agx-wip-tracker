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
                return window.p86Confirm({
                    title: opts.title || ('Delete ' + label),
                    message: msg,
                    confirmLabel: opts.confirmLabel || 'Delete',
                    cancelLabel: opts.cancelLabel || 'Cancel',
                    danger: opts.danger !== false
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
            const totalBudget = buildings.reduce((sum, b) => sum + (b.budget || 0), 0);
            if (totalBudget > 0) {
                const bldgPct = (thisBldg?.budget || 0) / totalBudget;
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

        // Auto-calculate building % complete from its phases (weighted by phaseBudget)
        function calcBuildingPctComplete(buildingId, jobId) {
            const bldgPhases = appData.phases.filter(p => p.jobId === jobId && p.buildingId === buildingId);
            if (bldgPhases.length === 0) return 0;
            const totalBudget = bldgPhases.reduce((s, p) => s + (p.phaseBudget || 0), 0);
            if (totalBudget > 0) {
                return bldgPhases.reduce((s, p) => s + (p.pctComplete || 0) * (p.phaseBudget || 0), 0) / totalBudget;
            }
            // Equal weight if no budgets set
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

            // 1. Building-weighted, but only if phases are actually attached
            if (buildings.length > 0 && linkedPhases.length > 0) {
                const bldgData = buildings.map(b => ({
                    budget: b.budget || 0,
                    pct: calcBuildingPctComplete(b.id, jobId)
                }));
                const totalBudget = bldgData.reduce((s, d) => s + d.budget, 0);
                if (totalBudget > 0) {
                    return bldgData.reduce((s, d) => s + d.pct * d.budget, 0) / totalBudget;
                }
                return bldgData.reduce((s, d) => s + d.pct, 0) / bldgData.length;
            }

            // 2. Phase-weighted directly (covers both no-buildings and
            //    buildings-but-phases-not-linked cases)
            if (phases.length > 0) {
                const totalBudget = phases.reduce((s, p) => s + (p.phaseBudget || 0), 0);
                if (totalBudget > 0) {
                    return phases.reduce((s, p) => s + (p.pctComplete || 0) * (p.phaseBudget || 0), 0) / totalBudget;
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

            jobSubs.forEach(sub => {
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

        // ==================== WIP CALCULATIONS ====================
        function getJobCOTotals(jobId) {
            const cos = appData.changeOrders.filter(co => co.jobId === jobId);
            return {
                income: cos.reduce((sum, co) => sum + (co.income || 0), 0),
                costs: cos.reduce((sum, co) => sum + (co.estimatedCosts || 0), 0),
                count: cos.length
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
            let qbActualCosts = 0, qbCostLineCount = 0, qbCostsAsOf = null;
            try {
                const qbLines = (window.appData && Array.isArray(appData.qbCostLines))
                    ? appData.qbCostLines.filter(l => (l.job_id || l.jobId) === jobId) : [];
                qbCostLineCount = qbLines.length;
                qbLines.forEach(l => {
                    qbActualCosts += Number(l.amount || 0);
                    const d = l.report_date || l.reportDate;
                    if (d && (!qbCostsAsOf || String(d) > String(qbCostsAsOf))) qbCostsAsOf = String(d).slice(0, 10);
                });
            } catch (e) {}
            const actualCosts = (job.ngActualCosts != null)
                ? job.ngActualCosts
                : (getJobTotalCost(jobId).total + qbActualCosts);
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
            const revenueEarned = (job.ngRevenueEarned != null)
                ? job.ngRevenueEarned
                : totalIncome * (pctComplete / 100);
            const jtdProfit = (job.ngJtdProfit != null)
                ? job.ngJtdProfit
                : revenueEarned - actualCosts;
            const jtdMargin = (job.ngJtdMargin != null)
                ? job.ngJtdMargin
                : (revenueEarned > 0 ? (jtdProfit / revenueEarned * 100) : 0);
            const invoiced = job.invoicedToDate || 0;
            const unbilled = revenueEarned - invoiced;
            const backlog = (job.ngBacklog != null)
                ? job.ngBacklog
                : totalIncome - revenueEarned;
            const remainingCosts = revisedEstCosts - actualCosts;
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
            const displayProfit = hasActuals ? jtdProfit : revisedProfit;
            const displayMargin = hasActuals ? jtdMargin : revisedMargin;
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
                invoiced, unbilled, backlog, remainingCosts
            };
        }
        // Exposed for js/job-audit.js (R8 margin-drift + R10 underbilled rules).
        window.getJobWIP = getJobWIP;

        function renderWipTab(jobId) {
            const job = appData.jobs.find(j => j.id === jobId);
            if (!job) return;
            const w = getJobWIP(jobId);
            document.getElementById('wipPctComplete').value = job.pctComplete || '';
            document.getElementById('wipPctManual').checked = job.pctCompleteManual || false;
            document.getElementById('wipInvoicedToDate').value = job.invoicedToDate || '';
            document.getElementById('wipRevisedCostChanges').value = job.revisedCostChanges || '';
            document.getElementById('wipNotes').value = job.notes || '';

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

        function saveWipInputs() {
            const job = appData.jobs.find(j => j.id === appState.currentJobId);
            if (!job) return;
            const newPct = parseFloat(document.getElementById('wipPctComplete').value) || 0;
            const isManual = document.getElementById('wipPctManual').checked;
            job.pctCompleteManual = isManual;

            // If manual override and % increased, auto-distribute to buildings/phases
            if (isManual && newPct > (job.pctComplete || 0)) {
                distributeJobPctComplete(appState.currentJobId, newPct);
            }

            job.pctComplete = newPct;
            job.invoicedToDate = parseFloat(document.getElementById('wipInvoicedToDate').value) || 0;
            job.revisedCostChanges = parseFloat(document.getElementById('wipRevisedCostChanges').value) || 0;
            job.notes = document.getElementById('wipNotes').value.trim();
            job.updatedAt = new Date().toISOString();
            saveData();
            renderJobDetail(appState.currentJobId);
        }

        /** Distribute job-level % complete down to buildings and phases proportionally */
        function distributeJobPctComplete(jobId, targetPct) {
            const buildings = appData.buildings.filter(b => b.jobId === jobId);
            const phases = appData.phases.filter(p => p.jobId === jobId);

            if (buildings.length > 0) {
                // Distribute to buildings, then each building distributes to its phases
                buildings.forEach(b => {
                    const bldgPhases = phases.filter(p => p.buildingId === b.id);
                    if (bldgPhases.length > 0) {
                        bldgPhases.forEach(p => {
                            p.pctComplete = Math.min(100, Math.max(p.pctComplete || 0, targetPct));
                        });
                    }
                });
            } else if (phases.length > 0) {
                phases.forEach(p => {
                    p.pctComplete = Math.min(100, Math.max(p.pctComplete || 0, targetPct));
                });
            }
        }

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
            return (Array.isArray(po && po.bills) ? po.bills : []).reduce(function(s, b) {
                return s + (parseFloat(b.amount) || 0);
            }, 0);
        }

        function renderJobPurchaseOrdersInto(container, jobId, mountId) {
            var mount = document.createElement('div');
            mount.id = mountId || 'job-overview-purchase-orders';
            mount.style.cssText = 'margin-top:4px;';
            container.appendChild(mount);
            paintJobPurchaseOrdersInto(mount, jobId);
            loadPurchaseOrdersForJob(jobId).then(function() {
                paintJobPurchaseOrdersInto(mount, jobId);
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
            pop.querySelectorAll('[data-del]').forEach(function(a) { a.addEventListener('click', function(e) { e.preventDefault(); e.stopPropagation(); if (!confirm('Delete this saved view?')) return; var id = a.getAttribute('data-del'); window.p86Api.listViews.remove(id).then(function() { if (_jobsActiveViewId === id) _jobsActiveViewId = null; return jobsLoadViews(); }).then(close); }); });
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
            const accruedCosts = getJobAccruedCosts(jobId);
            document.getElementById('job-summary-accrued').textContent = formatCurrency(accruedCosts);
            document.getElementById('job-summary-accrued-note').textContent = accruedCosts > 0 ? 'Earned but unbilled' : '';
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
                    '<button class="header-icon-btn" data-p86-icon="phases" onclick="openAddPhaseToJobModal()" title="Add Phase" aria-label="Add Phase"></button>' +
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

            // ── Weather widget ──
            // 7-day NWS forecast for the job's address. Self-contained:
            // schedule.js owns the fetch + render. We just give it a
            // mount point. Renders muted placeholders if the job has no
            // address yet so the widget never shouts "broken" — it just
            // explains why the data isn't there.
            if (window.p86Weather && typeof window.p86Weather.renderJobWidget === 'function') {
                var wxMount = document.createElement('div');
                wxMount.style.cssText = 'margin:0 0 14px 0;';
                wxMount.id = 'job-overview-weather';
                container.appendChild(wxMount);
                window.p86Weather.renderJobWidget(wxMount, jobId);
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
                container.appendChild(projWrap);
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
                container.appendChild(taskWrap);
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
                container.appendChild(fileWrap);
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
                        if (wxm) { try { window.p86Weather.renderJobWidget(wxm, healJobId); } catch (e) {} }
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
                container.appendChild(bldgSection);
                renderJobBuildings(jobId);
            }

            if (buildings.length === 0) {
                // insertAdjacentHTML, NOT innerHTML += : `+=` reparses the whole
                // container and recreates every child, orphaning the async widget
                // mounts (weather / projects / tasks / files) that were appended
                // moments earlier — their in-flight fetches then paint detached
                // nodes and the panels stay stuck on "Loading…". Only jobs with
                // zero buildings hit this branch, which is why it looked random.
                container.insertAdjacentHTML('beforeend', '<div style="text-align:center;padding:30px;color:var(--text-dim);font-size:13px;">No buildings or phases yet. Use the buttons above to get started.</div>');
            }

            // ── Phases summary (grouped, expandable, with node connections) ──
            const jobPhases = appData.phases.filter(p => p.jobId === jobId);
            const phSection = document.createElement('div');
            phSection.style.cssText = 'margin-top:14px;';
            phSection.id = 'job-overview-phases';
            renderOverviewPhasesInto(phSection, jobId, jobPhases);
            container.appendChild(phSection);

            // ── Subcontractors summary (cards with expandable connections) ──
            const jobSubs = appData.subs.filter(s => s.jobId === jobId);
            if (jobSubs.length > 0) {
                const subsSection = document.createElement('div');
                subsSection.style.cssText = 'margin-top:14px;';
                subsSection.id = 'job-overview-subs';
                renderOverviewSubsInto(subsSection, jobId, jobSubs);
                container.appendChild(subsSection);
            }

            // ── Change Orders + Purchase Orders (server-backed) ──
            // Renders the job_change_orders / job_purchase_orders entities —
            // the same records the dedicated subtabs + Jobs hub use. The old
            // localStorage CO/PO summary blocks were removed so the overview
            // no longer shows stale pre-migration data.
            renderJobChangeOrdersInto(container, jobId);
            renderJobPurchaseOrdersInto(container, jobId);

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
                container.appendChild(invSection);
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
            const cos = appData.changeOrders.filter(c => c.jobId === jobId);
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
                    return { id:c.id, coNumber:c.coNumber, income:c.income||0, estimatedCosts:c.estimatedCosts||0, pctComplete:c.pctComplete||0 };
                }),
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
        function buildingEffectiveBudget(building, jobId) {
            if ((building.budget || 0) > 0) return { amount: building.budget, derived: false };
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
            return { amount: sum, derived: sum > 0 };
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

        function renderJobBuildings(jobId, hostId) {
            const buildings = appData.buildings.filter(b => b.jobId === jobId);
            const container = document.getElementById(hostId || 'job-buildings-content');
            if (!container) return;   // host may be absent (e.g. node-graph inspector passes its own id)
            if (!buildings.length) { container.innerHTML = ''; return; }

            const totalBudget = buildings.reduce((s, b) => s + buildingEffectiveBudget(b, jobId).amount, 0);

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
                            (building.coBudget ? '<span class="p86-bldg-co-tag">+' + formatCurrency(building.coBudget) + '</span>' : '') +
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

            container.innerHTML =
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
                return '<span style="color:var(--text-dim);font-size:10px;">Budget: <b style="color:var(--accent);">' + formatCurrency(bldg.budget || 0) + '</b></span>';
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

        function renderConnectionList(conns) {
            if (!conns.length) return '<div style="font-size:11px;color:var(--text-dim);font-style:italic;">Not placed on graph yet</div>';
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
                var coEntry = appData.changeOrders.find(function(c) { return c.id === src.data.id; });
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

        function renderOverviewPhasesInto(container, jobId, phases) {
            container.innerHTML = '';
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

            const titleHTML =
                '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;gap:10px;flex-wrap:wrap;">' +
                    '<h3 style="font-size:13px;margin:0;">&#x1F4CB; Phases (' + groupKeys.length + ')</h3>' +
                    '<div style="display:flex;align-items:center;gap:10px;">' +
                        '<div style="font-size:12px;color:var(--text-dim);">Rev: <b style="color:var(--green);">' + formatCurrency(totalRev) + '</b> &nbsp; Cost: <b>' + formatCurrency(totalCost) + '</b> &nbsp; Profit: <b style="color:' + (totalProfit >= 0 ? 'var(--green)' : 'var(--red)') + ';">' + formatCurrency(totalProfit) + '</b></div>' +
                        '<button class="ee-btn ghost" style="font-size:12px;padding:3px 10px;white-space:nowrap;" onclick="addJobLevelPhase(\'' + escapeHTML(jobId) + '\')">+ Phase</button>' +
                    '</div>' +
                '</div>';

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

            container.innerHTML = titleHTML +
                '<div class="phase-matrix-host"></div>' +
                '<div style="border:1px solid var(--border,#333);border-radius:10px;overflow-x:auto;background:var(--card-bg,#141419);">' +
                    '<table style="width:100%;border-collapse:collapse;table-layout:auto;">' +
                        '<thead style="background:var(--overlay-light,rgba(255,255,255,0.02));border-bottom:1px solid var(--border,#333);"><tr>' +
                            thCell('Phase', 'left') +
                            thCell('Instances', 'right') +
                            thCell('Revenue', 'right') +
                            thCell('Cost', 'right') +
                            thCell('Profit', 'right') +
                            thCell('Avg %', 'right') +
                        '</tr></thead>' +
                        '<tbody>' + rowsHTML + '</tbody>' +
                    '</table>' +
                '</div>';
            try { renderPhaseMatrixInto(container.querySelector('.phase-matrix-host'), jobId); } catch (e) {}
        }

        // ── Buildings × Phases matrix — the job-first budget breakdown ──────
        // Rows = phase names, columns = buildings + Unassigned + Total. Each
        // cell = that phase's as-sold budget slice for that building (editable).
        // Row total = the phase's job-level total (sum of its slices); column
        // total = each building's roll-up; grand total = the job's phased
        // budget. Editing a cell writes the per-(phase,building) phase record's
        // asSoldPhaseBudget (create-on-demand) — the same survivable field the
        // building breakdown modal uses (SP-1: building budget derives from it).
        function renderPhaseMatrixInto(container, jobId) {
            if (!container) return;
            var phases = (appData.phases || []).filter(function(p) { return p.jobId === jobId; });
            var buildings = (appData.buildings || []).filter(function(b) { return b.jobId === jobId; });
            var names = [];
            phases.forEach(function(p) { var n = p.phase || 'Unnamed'; if (names.indexOf(n) === -1) names.push(n); });
            names.sort();
            if (!names.length || !buildings.length) { container.innerHTML = ''; return; }
            // Local attribute escaper — jobs.js has no escapeAttr, and using an
            // undefined one silently threw (empty matrix). Quote-safe for the
            // data-* attrs + input values below.
            var attr = function(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
            var cols = buildings.map(function(b) { return { id: b.id, name: b.name || 'Building' }; });
            function slice(name, bid) {
                var r = phases.find(function(p) { return (p.phase || 'Unnamed') === name && (p.buildingId || null) === (bid || null); });
                return r ? (r.asSoldPhaseBudget || r.phaseBudget || 0) : 0;
            }
            var colTot = {}; cols.forEach(function(c) { colTot[c.id] = 0; }); var unTot = 0, grand = 0;
            var stickL = 'position:sticky;left:0;background:var(--card-bg,#141419);z-index:1;';

            var head = '<tr><th style="text-align:left;padding:5px 8px;font-size:11px;color:var(--text-dim);' + stickL + '">Phase</th>';
            cols.forEach(function(c) { head += '<th style="text-align:right;padding:5px 8px;font-size:11px;color:var(--text-dim);white-space:nowrap;">' + escapeHTML(c.name) + '</th>'; });
            head += '<th style="text-align:right;padding:5px 8px;font-size:11px;color:var(--text-dim);">Unassigned</th>';
            head += '<th style="text-align:right;padding:5px 8px;font-size:11px;color:var(--accent);">Total</th></tr>';

            function cellInput(name, bid, v, dashed) {
                return '<td style="text-align:right;padding:3px 4px;"><input type="number" min="0" step="100" value="' + (v || '') + '" ' +
                    'data-mx-phase="' + attr(name) + '" data-mx-bldg="' + attr(bid || '') + '" oninput="onPhaseMatrixCell(this)" ' +
                    'style="width:76px;font-size:12px;padding:3px 5px;text-align:right;background:var(--bg);border:1px ' + (dashed ? 'dashed' : 'solid') + ' var(--border);border-radius:4px;color:var(--text' + (dashed ? '-dim' : '') + ');"/></td>';
            }
            var body = names.map(function(name) {
                var rowTot = 0;
                var cells = cols.map(function(c) { var v = slice(name, c.id); colTot[c.id] += v; rowTot += v; return cellInput(name, c.id, v, false); }).join('');
                var u = slice(name, null); unTot += u; rowTot += u;
                grand += rowTot;
                return '<tr><td style="text-align:left;padding:4px 8px;font-size:12.5px;font-weight:600;color:var(--text);white-space:nowrap;' + stickL + '">' + escapeHTML(name) + '</td>' +
                    cells + cellInput(name, null, u, true) +
                    '<td data-mx-rowtot="' + attr(name) + '" style="text-align:right;padding:4px 8px;font-size:12.5px;font-weight:700;color:var(--accent);font-family:monospace;">' + formatCurrency(rowTot) + '</td></tr>';
            }).join('');

            var foot = '<tr style="border-top:2px solid var(--border);"><td style="text-align:left;padding:5px 8px;font-size:11px;font-weight:700;color:var(--text-dim);' + stickL + '">Building total</td>';
            cols.forEach(function(c) { foot += '<td data-mx-coltot="' + attr(c.id) + '" style="text-align:right;padding:5px 8px;font-size:12px;font-weight:700;font-family:monospace;">' + formatCurrency(colTot[c.id]) + '</td>'; });
            foot += '<td data-mx-coltot="__un__" style="text-align:right;padding:5px 8px;font-size:12px;font-weight:700;font-family:monospace;color:var(--text-dim);">' + formatCurrency(unTot) + '</td>';
            foot += '<td data-mx-grand style="text-align:right;padding:5px 8px;font-size:13px;font-weight:800;font-family:monospace;color:var(--accent);">' + formatCurrency(grand) + '</td></tr>';

            container.innerHTML =
                '<div style="display:flex;justify-content:space-between;align-items:center;margin:2px 0 6px;gap:8px;flex-wrap:wrap;">' +
                    '<h4 style="font-size:12px;margin:0;color:var(--text-dim);text-transform:uppercase;letter-spacing:.5px;">Buildings &times; Phases</h4>' +
                    '<span style="font-size:11px;color:var(--text-dim);">Split each phase’s total down to buildings. Row = job-level total.</span>' +
                '</div>' +
                '<div style="border:1px solid var(--border,#333);border-radius:10px;overflow-x:auto;background:var(--card-bg,#141419);margin-bottom:12px;">' +
                    '<table style="width:100%;border-collapse:collapse;"><thead>' + head + '</thead><tbody>' + body + '</tbody><tfoot>' + foot + '</tfoot></table>' +
                '</div>';
        }

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
            if (typeof saveData === 'function') saveData();
            recomputePhaseMatrixTotals(input, jobId);
        }
        window.onPhaseMatrixCell = onPhaseMatrixCell;

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

        function addPhaseFromBuildingModal() {
            if (!appState.editBuildingId) return;
            const phaseName = prompt('Phase name (e.g., Electrical, Plumbing):');
            if (!phaseName || !phaseName.trim()) return;
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
            if (!confirm('Delete this phase?')) return;
            appData.phases = appData.phases.filter(p => p.id !== phaseId);
            renderBuildingPhaseBreakdown(appState.editBuildingId);
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

        function addCOFromBuildingModal() {
            if (!appState.editBuildingId) return;
            const desc = prompt('CO description:');
            if (!desc || !desc.trim()) return;
            const incomeStr = prompt('Income (budget addition) $:', '0');
            const costStr = prompt('Estimated cost $:', '0');
            const co = {
                id: 'co' + Date.now(),
                jobId: appState.currentJobId,
                coNumber: '',
                description: desc.trim(),
                income: parseFloat(incomeStr) || 0,
                estimatedCosts: parseFloat(costStr) || 0,
                date: new Date().toISOString().split('T')[0],
                notes: '',
                allocationType: 'building',
                allocations: [{
                    buildingId: appState.editBuildingId,
                    income: parseFloat(incomeStr) || 0,
                    estimatedCosts: parseFloat(costStr) || 0
                }]
            };
            appData.changeOrders.push(co);
            if (typeof saveData === 'function') saveData();
            renderBuildingCOBreakdown(appState.editBuildingId);
        }

        function removeCOFromBreakdown(coId) {
            if (!confirm('Delete this change order?')) return;
            appData.changeOrders = appData.changeOrders.filter(c => c.id !== coId);
            if (typeof saveData === 'function') saveData();
            renderBuildingCOBreakdown(appState.editBuildingId);
        }

        function deleteBuilding() {
            if (!appState.editBuildingId) return;
            const bldgId = appState.editBuildingId;
            const phases = appData.phases.filter(p => p.buildingId === bldgId);
            if (phases.length > 0) {
                if (!confirm('This building has ' + phases.length + ' phase(s). Delete the building AND all its phases?')) return;
                appData.phases = appData.phases.filter(p => p.buildingId !== bldgId);
            } else {
                if (!confirm('Delete this building?')) return;
            }
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
                    const nodeIdsToRemove = ngNodes.filter(n =>
                        (n.type === 't1' && n.data && n.data.id === bldgId) ||
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
                    Object.assign(appData.buildings[idx], formData);
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
            document.getElementById('phaseModalHeader').textContent = 'Add Phase Entry';
            document.getElementById('savePhaseBtn').innerHTML = '&#x1F4CB; Add Phase';
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
            document.getElementById('phaseModalHeader').textContent = 'Edit Phase Entry';
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
            if (!confirm('Delete this phase entry? This cannot be undone.')) return;
            const phaseId = appState.editPhaseId;
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
            if (!confirm('Delete ' + phases.length + ' phase record(s) in this group? This cannot be undone.')) return;
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
            if (!confirm('Delete this subcontractor?')) return;
            appData.subs = appData.subs.filter(s => s.id !== subId);
            saveData();
            renderJobDetail(appState.currentJobId);
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
            if (!confirm('Permanently delete this job and all its data? This cannot be undone.')) return;
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
        